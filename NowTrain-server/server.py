"""
Realtime Train SSE Server (FastAPI) - 完全版
-------------------------------------------
機能:
- odpt:Train + odpt:TrainTimetable で精密な位置補間
- odpt:Station で駅座標キャッシュ
- GTFS形式でフロントに配信
"""

import asyncio
import json
import os
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

# 設定
ODPT_BASE = os.getenv("ODPT_BASE", "https://api-challenge.odpt.org/api/v4")
ODPT_KEY = os.getenv("ODPT_CONSUMER_KEY", "")
POLL_INTERVAL_SEC = int(os.getenv("POLL_INTERVAL_SEC", "3"))
SSE_HEARTBEAT_SEC = int(os.getenv("SSE_HEARTBEAT_SEC", "1"))
TTL_SEC = int(os.getenv("TTL_SEC", "15"))

# 正規化ユーティリティ
def normalize_railway_id(raw: str) -> str:
    if not raw:
        return raw
    if raw.startswith("odpt.Railway:"):
        return raw.split(":", 1)[1]
    return raw

def normalize_trip_id(raw: str) -> str:
    if not raw:
        return raw
    if raw.startswith("odpt.Train:"):
        raw = raw.split(":", 1)[1]
    # 末尾の .YYYYMMDD を削除
    parts = raw.split(".")
    if len(parts) >= 2 and parts[-1].isdigit() and len(parts[-1]) == 8:
        parts = parts[:-1]
    return ".".join(parts)

def time_to_seconds(time_str: str) -> int:
    """HH:mm:ss を秒に変換（24時超対応）"""
    if not time_str:
        return 0
    parts = time_str.split(":")
    h = int(parts[0])
    m = int(parts[1])
    s = int(parts[2]) if len(parts) > 2 else 0
    return h * 3600 + m * 60 + s

def unix_ts() -> int:
    return int(time.time())

# スキーマ
class Vehicle(BaseModel):
    trip_id: str
    lat: Optional[float] = None
    lng: Optional[float] = None
    status: Optional[str] = None
    bearing: Optional[float] = None
    speed_kph: Optional[float] = None
    from_stop_id: Optional[str] = None
    to_stop_id: Optional[str] = None
    timestamp: Optional[int] = None
    progress: Optional[float] = None

class Snapshot(BaseModel):
    ts: int
    seq: int
    railwayId: Optional[str] = None
    vehicles: List[Vehicle]

# ODPT API
async def odpt_get(client: httpx.AsyncClient, path: str, params: Dict[str, Any]) -> List[Dict[str, Any]]:
    p = {"acl:consumerKey": ODPT_KEY}
    p.update(params)
    url = f"{ODPT_BASE}/{path}"
    r = await client.get(url, params=p, timeout=30)
    r.raise_for_status()
    return r.json()

async def fetch_odpt_stations(client: httpx.AsyncClient, railway_id: Optional[str] = None) -> List[Dict[str, Any]]:
    params = {}
    if railway_id:
        params["odpt:railway"] = railway_id
    return await odpt_get(client, "odpt:Station", params)

async def fetch_odpt_trains(client: httpx.AsyncClient, railway_id: Optional[str] = None) -> List[Dict[str, Any]]:
    params = {}
    if railway_id:
        params["odpt:railway"] = railway_id
    return await odpt_get(client, "odpt:Train", params)

async def fetch_odpt_timetables(client: httpx.AsyncClient, railway_id: str, calendar: str = "Weekday") -> List[Dict[str, Any]]:
    params = {
        "odpt:railway": railway_id,
        "odpt:calendar": f"odpt.Calendar:{calendar}"
    }
    return await odpt_get(client, "odpt:TrainTimetable", params)

# キャッシュ
class DataCache:
    def __init__(self) -> None:
        self.seq = 0
        self.vehicles_by_railway: Dict[str, List[Vehicle]] = {}
        self.last_seen_by_trip: Dict[str, int] = {}
        
        # 駅キャッシュ: {station_id: {lat, lng, name}}
        self.stations: Dict[str, Dict[str, Any]] = {}
        
        # 時刻表キャッシュ: {trip_id: {stops: [{stop_id, arrival, departure, sequence}]}}
        self.timetables: Dict[str, Dict[str, Any]] = {}

    def snapshot(self, railway_id_norm: Optional[str]) -> Snapshot:
        self.seq += 1
        now = unix_ts()
        vehicles: List[Vehicle]
        if railway_id_norm:
            items = self.vehicles_by_railway.get(railway_id_norm, [])
            vehicles = [v for v in items if v.timestamp is None or now - v.timestamp <= TTL_SEC]
        else:
            all_items: List[Vehicle] = []
            for arr in self.vehicles_by_railway.values():
                all_items.extend(arr)
            vehicles = [v for v in all_items if v.timestamp is None or now - v.timestamp <= TTL_SEC]
        return Snapshot(ts=now, seq=self.seq, railwayId=railway_id_norm, vehicles=vehicles)

cache = DataCache()
client = httpx.AsyncClient()
app = FastAPI()

# CORS設定を追加
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 開発用: すべてのオリジンを許可
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 位置補間関数
def interpolate_position(
    from_station: Dict[str, Any],
    to_station: Dict[str, Any],
    timetable_stops: List[Dict[str, Any]],
    current_time_sec: int,
    delay_sec: int
) -> Optional[Dict[str, float]]:
    """駅間の位置を時刻表ベースで補間"""
    
    # from/to の駅IDを探す
    from_idx = None
    to_idx = None
    
    for i, stop in enumerate(timetable_stops):
        if stop["stop_id"] == from_station.get("id"):
            from_idx = i
        if stop["stop_id"] == to_station.get("id"):
            to_idx = i
    
    if from_idx is None or to_idx is None or from_idx >= to_idx:
        return None
    
    from_stop = timetable_stops[from_idx]
    to_stop = timetable_stops[to_idx]
    
    # 発車時刻と到着時刻
    dep_time = time_to_seconds(from_stop.get("departure") or from_stop.get("arrival", "00:00:00"))
    arr_time = time_to_seconds(to_stop.get("arrival", "00:00:00"))
    
    if arr_time <= dep_time:
        return None
    
    # 遅延を反映
    adjusted_current = current_time_sec
    adjusted_dep = dep_time + delay_sec
    adjusted_arr = arr_time + delay_sec
    
    # 進捗率計算
    if adjusted_current < adjusted_dep:
        progress = 0.0
    elif adjusted_current > adjusted_arr:
        progress = 1.0
    else:
        progress = (adjusted_current - adjusted_dep) / (adjusted_arr - adjusted_dep)
    
    # 座標補間
    from_lat = from_station.get("lat")
    from_lng = from_station.get("lng")
    to_lat = to_station.get("lat")
    to_lng = to_station.get("lng")
    
    if None in [from_lat, from_lng, to_lat, to_lng]:
        return None
    
    lat = from_lat + (to_lat - from_lat) * progress
    lng = from_lng + (to_lng - from_lng) * progress
    
    return {"lat": lat, "lng": lng, "progress": progress}

# データ変換
def map_odpt_trains_to_vehicles(items: List[Dict[str, Any]]) -> List[Vehicle]:
    out: List[Vehicle] = []
    now = unix_ts()
    
    # 現在の時刻（秒）- 今日の00:00からの経過秒数
    current_dt = datetime.now()
    current_time_sec = current_dt.hour * 3600 + current_dt.minute * 60 + current_dt.second
    
    for idx, it in enumerate(items):
        # odpt:train でtrip_idを取得（最優先）
        trip_id_raw = it.get("odpt:train") or it.get("owl:sameAs") or ""
        if not trip_id_raw:
            continue
        
        trip_id = normalize_trip_id(str(trip_id_raw))
        
        # 駅情報
        from_station_id = it.get("odpt:fromStation")
        to_station_id = it.get("odpt:toStation")
        
        # 遅延（秒）
        delay = it.get("odpt:delay", 0)
        
        # タイムスタンプ
        ts_iso = it.get("dct:valid") or it.get("dc:date")
        ts_epoch = now
        if ts_iso:
            try:
                ts_iso_clean = ts_iso.replace("Z", "+00:00")
                dt = datetime.fromisoformat(ts_iso_clean)
                ts_epoch = int(dt.timestamp())
            except Exception:
                pass
        
        # 状態判定
        if to_station_id is None:
            # 駅に停車中
            status = "STOPPED_AT"
            station = cache.stations.get(from_station_id)
            if station:
                lat = station["lat"]
                lng = station["lng"]
                progress = 0.0
            else:
                lat = None
                lng = None
                progress = 0.0
        else:
            # 駅間移動中
            status = "IN_TRANSIT_TO"
            
            # 時刻表から位置を補間
            timetable = cache.timetables.get(trip_id_raw) or cache.timetables.get(trip_id)
            from_station = cache.stations.get(from_station_id)
            to_station = cache.stations.get(to_station_id)
            
            if timetable and from_station and to_station:
                pos = interpolate_position(
                    from_station,
                    to_station,
                    timetable["stops"],
                    current_time_sec,
                    delay
                )
                if pos:
                    lat = pos["lat"]
                    lng = pos["lng"]
                    progress = pos["progress"]
                else:
                    # フォールバック: 中間地点
                    lat = (from_station["lat"] + to_station["lat"]) / 2
                    lng = (from_station["lng"] + to_station["lng"]) / 2
                    progress = 0.5
            else:
                # 駅座標だけある場合は中間地点
                if from_station and to_station:
                    lat = (from_station["lat"] + to_station["lat"]) / 2
                    lng = (from_station["lng"] + to_station["lng"]) / 2
                    progress = 0.5
                else:
                    lat = None
                    lng = None
                    progress = 0.0
        
        out.append(
            Vehicle(
                trip_id=trip_id,
                lat=lat,
                lng=lng,
                status=status,
                from_stop_id=from_station_id,
                to_stop_id=to_station_id,
                timestamp=ts_epoch,
                progress=progress
            )
        )
    
    return out

# ポーリングループ
async def poll_loop() -> None:
    await asyncio.sleep(0.2)
    print("=" * 60)
    print("[poll_loop] STARTED!")
    print("=" * 60)
    
    # 起動時に駅データを取得
    try:
        print("[poll_loop] Loading station data...")
        stations = await fetch_odpt_stations(client, None)
        for station in stations:
            station_id = station.get("owl:sameAs")
            lat = station.get("geo:lat")
            lng = station.get("geo:long") or station.get("geo:lon")
            name = station.get("dc:title") or station.get("odpt:stationTitle", {}).get("ja", "")
            if station_id and lat and lng:
                cache.stations[station_id] = {"id": station_id, "lat": lat, "lng": lng, "name": name}
        print(f"[poll_loop] Loaded {len(cache.stations)} stations")
    except Exception as e:
        print(f"[poll_loop] Failed to load stations: {e}")
    
    # 起動時に時刻表を取得（JR東日本の主要路線）
    target_railways = [
        "odpt.Railway:JR-East.ChuoSobuLocal",
        "odpt.Railway:JR-East.ChuoRapid",
        "odpt.Railway:JR-East.Yamanote",
    ]
    
    for railway_id in target_railways:
        try:
            print(f"[poll_loop] Loading timetables for {railway_id}...")
            timetables = await fetch_odpt_timetables(client, railway_id, "Weekday")
            
            for tt in timetables:
                trip_id_raw = tt.get("odpt:train")
                if not trip_id_raw:
                    continue
                
                stops = []
                for i, obj in enumerate(tt.get("odpt:trainTimetableObject", [])):
                    # デバッグ: 最初の1件だけキーを出力
                    if i == 0:
                        print(f"[DEBUG] First timetable object keys: {list(obj.keys())}")
                        print(f"[DEBUG] Sample object: {obj}")
                    
                    stops.append({
                        "stop_id": obj.get("odpt:station"),
                        "arrival": obj.get("odpt:arrivalTime"),
                        "departure": obj.get("odpt:departureTime"),
                        "sequence": i + 1
                    })
                
                cache.timetables[trip_id_raw] = {"stops": stops}
                # 正規化版でも登録
                trip_id_norm = normalize_trip_id(trip_id_raw)
                cache.timetables[trip_id_norm] = {"stops": stops}
            
            print(f"[poll_loop] Loaded {len(timetables)} timetables for {railway_id}")
        except Exception as e:
            print(f"[poll_loop] Failed to load timetables for {railway_id}: {e}")
    
    # ポーリングループ
    while True:
        try:
            print("\n" + "=" * 60)
            print(f"[poll_loop] Polling at {datetime.now()}")
            print("=" * 60)
            
            railways = [None]  # 全路線取得
            for railway_filter in railways:
                odpt_trains = await fetch_odpt_trains(client, railway_filter)
                print(f"[poll_loop] ODPT returned: {len(odpt_trains)} trains")
                
                v_merged = map_odpt_trains_to_vehicles(odpt_trains)
                print(f"[poll_loop] Converted to {len(v_merged)} vehicles")
                
                if v_merged:
                    with_pos = sum(1 for v in v_merged if v.lat is not None)
                    print(f"[poll_loop] {with_pos}/{len(v_merged)} vehicles have positions")
                
                key = normalize_railway_id(railway_filter) if railway_filter else "__ALL__"
                cache.vehicles_by_railway[key] = v_merged
                
                now = unix_ts()
                for v in v_merged:
                    cache.last_seen_by_trip[v.trip_id] = now
                    
        except Exception as e:
            print(f"[poll_loop] ERROR: {type(e).__name__}: {e}")
            import traceback
            traceback.print_exc()
        finally:
            await asyncio.sleep(POLL_INTERVAL_SEC)

@app.on_event("startup")
async def on_startup():
    asyncio.create_task(poll_loop())

@app.get("/health")
async def health():
    return {"ok": True, "time": unix_ts(), "stations": len(cache.stations), "timetables": len(cache.timetables)}

@app.get("/api/stations")
async def api_stations(railwayId: Optional[str] = None):
    """駅リスト取得"""
    try:
        items = await fetch_odpt_stations(client, railwayId)
        out = []
        for it in items:
            out.append({
                "id": it.get("owl:sameAs"),
                "title": it.get("odpt:stationTitle", {}).get("ja") or it.get("dc:title"),
                "railwayId": normalize_railway_id(it.get("odpt:railway", "")),
                "lat": it.get("geo:lat"),
                "lng": it.get("geo:long") or it.get("geo:lon"),
            })
        return JSONResponse(out)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    
@app.get("/api/timetables")
async def get_timetables_api(railwayId: Optional[str] = None) -> Dict[str, Any]:
    """
    時刻表データをGTFS形式で返す
    返却形式: { trip_id: { stops: [{stop_id, arrival, departure, sequence}] } }
    """
    result = {}
    
    for trip_id, timetable in cache.timetables.items():
        # railwayIdが指定されている場合はフィルタ
        if railwayId:
            # trip_idに路線情報が含まれているか簡易チェック
            normalized_railway = normalize_railway_id(railwayId)
            if normalized_railway and normalized_railway not in trip_id:
                continue
        
        result[trip_id] = {
            "stops": timetable["stops"]
        }
    
    return result

@app.get("/api/trains/stream")
async def api_trains_stream(request: Request, railwayId: Optional[str] = None):
    """SSEでスナップショット配信"""
    railway_norm = normalize_railway_id(railwayId) if railwayId else None

    async def event_gen():
        last_sent_seq = -1
        last_hb = 0.0
        while True:
            if await request.is_disconnected():
                break
            snap = cache.snapshot(railway_norm)
            if snap.seq != last_sent_seq:
                data = snap.model_dump()
                yield f"event: snapshot\n" + f"data: {json.dumps(data, ensure_ascii=False)}\n\n"
                last_sent_seq = snap.seq
                last_hb = time.time()
            now = time.time()
            if now - last_hb >= SSE_HEARTBEAT_SEC:
                yield f"event: ping\n" + f"data: {unix_ts()}\n\n"
                last_hb = now
            await asyncio.sleep(0.2)

    headers = {
        "Cache-Control": "no-cache",
        "Content-Type": "text/event-stream",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(event_gen(), headers=headers, media_type="text/event-stream")
@app.get("/api/timetables")
async def get_timetables_api(railwayId: Optional[str] = None) -> Dict[str, Any]:
    """
    時刻表データをGTFS形式で返す
    返却形式: { trip_id: { stops: [{stop_id, arrival, departure, sequence}] } }
    """
    result = {}
    
    for trip_id, timetable in cache.timetables.items():
        # railwayIdが指定されている場合はフィルタ
        if railwayId:
            # trip_idに路線情報が含まれているか簡易チェック
            normalized_railway = normalize_railway_id(railwayId)
            if normalized_railway and normalized_railway not in trip_id:
                continue
        
        result[trip_id] = {
            "stops": timetable["stops"]
        }
    
    return result