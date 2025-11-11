import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Pause, RotateCcw, Upload, Database, Wifi, WifiOff, Loader, AlertCircle } from 'lucide-react';

// 時刻を秒に変換
const timeToSeconds = (timeStr) => {
  if (!timeStr) return 0;
  const parts = timeStr.split(':').map(Number);
  return parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
};

// 秒を時刻に変換
const secondsToTime = (seconds) => {
  const h = Math.floor(seconds / 3600) % 24;
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

// 列車の位置を計算（時刻表ベース）
const calculateScheduledPosition = (schedule, stations, currentTime) => {
  if (!schedule || schedule.length === 0) return null;

  for (let i = 0; i < schedule.length - 1; i++) {
    const current = schedule[i];
    const next = schedule[i + 1];

    const departureTime = timeToSeconds(current.departure || current.arrival);
    const arrivalTime = timeToSeconds(next.arrival);

    if (currentTime >= departureTime && currentTime <= arrivalTime) {
      const progress = (currentTime - departureTime) / (arrivalTime - departureTime);
      const currentStation = stations[current.stopId];
      const nextStation = stations[next.stopId];

      if (currentStation && nextStation) {
        return {
          lat: currentStation.lat + (nextStation.lat - currentStation.lat) * progress,
          lng: currentStation.lng + (nextStation.lng - currentStation.lng) * progress,
          fromStation: currentStation.name,
          toStation: nextStation.name,
          progress: progress,
          isMoving: true,
          source: 'schedule'
        };
      }
    }
  }

  return null;
};

// 2点間の線形補間
const lerp = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));

const TokyoTrainMap2D = () => {
  const canvasRef = useRef(null);
  const fileInputRef = useRef(null);
  const eventSourceRef = useRef(null);
  const animationFrameRef = useRef(null);

  const [isPlaying, setIsPlaying] = useState(true);
  const [currentTime, setCurrentTime] = useState(timeToSeconds('09:00:00'));
  const [hoveredTrain, setHoveredTrain] = useState(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  // データ管理
  const [stopsMap, setStopsMap] = useState({});
  const [routesMap, setRoutesMap] = useState({});
  const [trains, setTrains] = useState([]);
  const [selectedRoute, setSelectedRoute] = useState(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('準備完了');

  // リアルタイム管理
  const [liveConnected, setLiveConnected] = useState(false);
  const [realtimeMode, setRealtimeMode] = useState(false);
  const [realtimePositions, setRealtimePositions] = useState({});
  const [lastSeenByTrip, setLastSeenByTrip] = useState({});
  const [interpolatedPositions, setInterpolatedPositions] = useState({});
  const [lastSnapshot, setLastSnapshot] = useState(null);
  const [serverUrl, setServerUrl] = useState('http://localhost:8000');

  // TTL設定（サーバーと同じ15秒）
  const TTL_SEC = 15;
  const INTERPOLATION_SEC = 3; // サーバーのポーリング間隔

  // デモデータ読み込み
  useEffect(() => {
    loadDemoData();
  }, []);

  const loadDemoData = () => {
    const demoStops = {
      '1001': { id: '1001', name: '渋川', lat: 36.49123, lng: 139.00879 },
      '1002': { id: '1002', name: '金島', lat: 36.52958, lng: 138.97642 },
      '1003': { id: '1003', name: '柏母島', lat: 36.55593, lng: 138.95815 }
    };

    const demoRoute = {
      id: '10',
      name: '吾妻線',
      color: '#008689'
    };

    const demoTrains = [{
      tripId: '1003001M',
      routeId: '10',
      headsign: '長野原草津口',
      color: '#4CAF50',
      schedule: [
        { stopId: '1001', arrival: '11:37:00', departure: '11:37:00' },
        { stopId: '1002', arrival: '11:42:00', departure: '11:43:00' },
        { stopId: '1003', arrival: '11:48:00', departure: '11:48:00' }
      ]
    }];

    setStopsMap(demoStops);
    setRoutesMap({ '10': demoRoute });
    setTrains(demoTrains);
    setSelectedRoute('10');
    setStatus('✓ デモデータ準備完了');
  };

  // GTFS静的データ読み込み
  const parseGTFSData = async (files) => {
    try {
      setLoading(true);
      setStatus('データ解析中...');

      const fileMap = {};
      for (const file of files) {
        const text = await file.text();
        const data = JSON.parse(text);

        if (file.name.includes('stops')) fileMap.stops = data;
        else if (file.name.includes('routes')) fileMap.routes = data;
        else if (file.name.includes('trips')) fileMap.trips = data;
        else if (file.name.includes('stop_times')) fileMap.stopTimes = data;
      }

      if (!fileMap.stops || !fileMap.routes || !fileMap.trips || !fileMap.stopTimes) {
        throw new Error('必要なファイルが不足しています');
      }

      const stops = {};
      fileMap.stops.forEach(stop => {
        stops[stop.stop_id] = {
          id: stop.stop_id,
          name: stop.stop_name,
          lat: parseFloat(stop.stop_lat),
          lng: parseFloat(stop.stop_lon)
        };
      });

      const routes = {};
      fileMap.routes.forEach(route => {
        routes[route.route_id] = {
          id: route.route_id,
          name: route.route_long_name || route.route_short_name,
          color: route.route_color ? `#${route.route_color}` : '#4CAF50'
        };
      });

      const tripStopTimes = {};
      fileMap.stopTimes.forEach(st => {
        if (!tripStopTimes[st.trip_id]) {
          tripStopTimes[st.trip_id] = [];
        }
        tripStopTimes[st.trip_id].push({
          stopId: st.stop_id,
          arrival: st.arrival_time,
          departure: st.departure_time,
          sequence: parseInt(st.stop_sequence)
        });
      });

      Object.keys(tripStopTimes).forEach(tripId => {
        tripStopTimes[tripId].sort((a, b) => a.sequence - b.sequence);
      });

      const trainsList = fileMap.trips.map((trip, idx) => {
        const schedule = tripStopTimes[trip.trip_id];
        if (!schedule || schedule.length === 0) return null;

        return {
          tripId: trip.trip_id,
          routeId: trip.route_id,
          headsign: trip.trip_headsign || '',
          color: routes[trip.route_id]?.color || `hsl(${(idx * 137.5) % 360}, 70%, 50%)`,
          schedule: schedule
        };
      }).filter(Boolean);

      setStopsMap(stops);
      setRoutesMap(routes);
      setTrains(trainsList);

      const firstRouteId = Object.keys(routes)[0];
      setSelectedRoute(firstRouteId);

      setStatus(`✓ GTFS読み込み完了: ${Object.keys(stops).length}駅, ${trainsList.length}運行`);
      setLoading(false);

    } catch (error) {
      console.error('データ解析エラー:', error);
      setStatus(`✗ エラー: ${error.message}`);
      setLoading(false);
    }
  };

  // SSE接続
  const connectLive = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    // 暫定: 全路線取得（railwayIdパラメータなし）
    const url = `${serverUrl}/api/trains/stream`;

    setStatus('SSE接続中...');
    const es = new EventSource(url);

    es.onopen = () => {
      setLiveConnected(true);
      setRealtimeMode(true);
      setStatus('✓ リアルタイム接続成功');
    };

    es.addEventListener('snapshot', (event) => {
      try {
        const snapshot = JSON.parse(event.data);
        const now = Date.now() / 1000;

        // 前回のスナップショットを保存（補間用）
        if (lastSnapshot) {
          setLastSnapshot(snapshot);
        } else {
          setLastSnapshot(snapshot);
        }

        // realtimePositions更新
        const newPositions = {};
        const newLastSeen = {};

        snapshot.vehicles.forEach(vehicle => {
          if (vehicle.lat && vehicle.lng) {
            newPositions[vehicle.trip_id] = {
              lat: vehicle.lat,
              lng: vehicle.lng,
              status: vehicle.status,
              timestamp: vehicle.timestamp || now,
              bearing: vehicle.bearing,
              speed_kph: vehicle.speed_kph,
              from_stop_id: vehicle.from_stop_id,
              to_stop_id: vehicle.to_stop_id
            };
            newLastSeen[vehicle.trip_id] = now;
          }
        });

        setRealtimePositions(newPositions);
        setLastSeenByTrip(prev => ({ ...prev, ...newLastSeen }));
        setStatus(`✓ LIVE: ${snapshot.vehicles.length}編成 (seq:${snapshot.seq})`);
      } catch (error) {
        console.error('スナップショット解析エラー:', error);
      }
    });

    es.addEventListener('ping', () => {
      // ハートビート受信
    });

    es.onerror = () => {
      setLiveConnected(false);
      setStatus('✗ 接続エラー - 再接続中...');
      setTimeout(() => {
        if (realtimeMode) {
          connectLive();
        }
      }, 5000);
    };

    eventSourceRef.current = es;
  }, [selectedRoute, serverUrl, realtimeMode, lastSnapshot]);

  // ライブ接続切断
  const disconnectLive = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setLiveConnected(false);
    setRealtimeMode(false);
    setRealtimePositions({});
    setLastSeenByTrip({});
    setStatus('✓ ライブ接続を切断');
  };

  // 時刻表ベースの連続補間を計算する関数（クライアント側）
  const calculateContinuousPosition = useCallback((tripId, rtPos, currentTimeOfDay) => {
    // サーバーから受信したfrom_stop_id/to_stop_idと遅延を使用
    const fromStopId = rtPos.from_stop_id;
    const toStopId = rtPos.to_stop_id;
    const delay = rtPos.delay || 0;

    // 停車中の場合、駅位置を返す
    if (!toStopId || rtPos.status === 'STOPPED_AT') {
      return rtPos.lat && rtPos.lng ? {
        lat: rtPos.lat,
        lng: rtPos.lng,
        source: rtPos.source || 'schedule',
        progress: 0
      } : null;
    }

    // 列車の時刻表を探す
    const train = trains.find(t => t.tripId === tripId || t.tripId.includes(tripId) || tripId.includes(t.tripId));
    if (!train || !train.schedule) {
      // 時刻表が見つからない場合、サーバーの位置をそのまま使用
      return rtPos.lat && rtPos.lng ? {
        lat: rtPos.lat,
        lng: rtPos.lng,
        source: rtPos.source || 'realtime',
        progress: rtPos.progress || 0.5
      } : null;
    }

    // from_stop_id/to_stop_idに対応する駅を時刻表から探す
    // ODPT形式のIDから駅名を抽出して照合
    const extractStationName = (odptId) => {
      if (!odptId) return '';
      const parts = odptId.split('.');
      return parts[parts.length - 1]; // 例: "Shinjuku"
    };

    const fromStationName = extractStationName(fromStopId);
    const toStationName = extractStationName(toStopId);

    // 時刻表から該当する区間を探す
    let fromStop = null;
    let toStop = null;

    for (let i = 0; i < train.schedule.length - 1; i++) {
      const current = train.schedule[i];
      const next = train.schedule[i + 1];

      const currentStation = stopsMap[current.stopId];
      const nextStation = stopsMap[next.stopId];

      if (currentStation && nextStation) {
        const currentName = currentStation.name.replace(/\s/g, '').toLowerCase();
        const nextName = nextStation.name.replace(/\s/g, '').toLowerCase();

        if (currentName.includes(fromStationName.toLowerCase()) &&
            nextName.includes(toStationName.toLowerCase())) {
          fromStop = { ...current, station: currentStation };
          toStop = { ...next, station: nextStation };
          break;
        }
      }
    }

    if (!fromStop || !toStop) {
      // 該当区間が見つからない場合、サーバーの位置を使用
      return rtPos.lat && rtPos.lng ? {
        lat: rtPos.lat,
        lng: rtPos.lng,
        source: rtPos.source || 'realtime',
        progress: rtPos.progress || 0.5
      } : null;
    }

    // 時刻を秒に変換して進捗率を計算
    const depTime = timeToSeconds(fromStop.departure || fromStop.arrival) + delay;
    const arrTime = timeToSeconds(toStop.arrival) + delay;

    if (arrTime <= depTime) {
      return {
        lat: fromStop.station.lat,
        lng: fromStop.station.lng,
        source: 'schedule',
        progress: 0
      };
    }

    const progress = Math.max(0, Math.min(1, (currentTimeOfDay - depTime) / (arrTime - depTime)));

    // 座標を線形補間
    const lat = fromStop.station.lat + (toStop.station.lat - fromStop.station.lat) * progress;
    const lng = fromStop.station.lng + (toStop.station.lng - fromStop.station.lng) * progress;

    return {
      lat,
      lng,
      source: 'interpolated',
      progress,
      fromStation: fromStop.station.name,
      toStation: toStop.station.name
    };
  }, [trains, stopsMap]);

  // 補間アニメーション（60fps連続）
  useEffect(() => {
    if (!realtimeMode) return;

    let animationRunning = true;

    const animate = () => {
      if (!animationRunning) return;

      const now = Date.now();
      const currentTimeSec = now / 1000;

      // 現在時刻（当日の経過秒数）を計算
      const date = new Date();
      const currentTimeOfDay = date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();

      // 補間位置を計算
      const newInterpolated = {};

      Object.entries(realtimePositions).forEach(([tripId, rtPos]) => {
        // TTLチェック
        const lastSeen = lastSeenByTrip[tripId] || 0;
        const age = currentTimeSec - lastSeen;

        if (age > TTL_SEC) {
          // TTL切れ：表示しない
          return;
        }

        // クライアント側で時刻表ベースの連続補間を実行
        const interpolated = calculateContinuousPosition(tripId, rtPos, currentTimeOfDay);

        if (interpolated) {
          newInterpolated[tripId] = {
            ...interpolated,
            status: rtPos.status,
            timestamp: rtPos.timestamp,
            from_stop_id: rtPos.from_stop_id,
            to_stop_id: rtPos.to_stop_id,
            delay: rtPos.delay
          };
        }
      });

      setInterpolatedPositions(newInterpolated);
      animationFrameRef.current = requestAnimationFrame(animate);
    };

    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      animationRunning = false;
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [realtimeMode, realtimePositions, lastSeenByTrip, calculateContinuousPosition]);

  // ファイルアップロード
  const handleFileUpload = async (event) => {
    const files = Array.from(event.target.files);
    if (files.length === 0) return;
    await parseGTFSData(files);
  };

  // 現在の列車位置を取得
  const getCurrentTrainPositions = () => {
    if (Object.keys(stopsMap).length === 0 && !realtimeMode) return [];

    // リアルタイムモードの場合、interpolatedPositions から直接表示
    if (realtimeMode && Object.keys(interpolatedPositions).length > 0) {
      return Object.entries(interpolatedPositions).map(([tripId, rtPos]) => {
        return {
          tripId: tripId,
          routeId: 'realtime',
          headsign: rtPos.to_stop_id || 'リアルタイム',
          color: '#2196F3',
          position: {
            lat: rtPos.lat,
            lng: rtPos.lng,
            fromStation: rtPos.from_stop_id || '現在位置',
            toStation: rtPos.to_stop_id || '',
            progress: rtPos.progress || 0.5,
            isMoving: rtPos.status === 'IN_TRANSIT_TO',
            source: 'realtime',
            timestamp: rtPos.timestamp,
            status: rtPos.status
          }
        };
      });
    }

    // 時刻表モード（既存ロジック）
    if (!selectedRoute || trains.length === 0) return [];

    return trains
      .filter(train => train.routeId === selectedRoute)
      .map(train => {
        let position = null;

        // リアルタイムモードで、補間された位置がある場合
        if (realtimeMode && interpolatedPositions[train.tripId]) {
          const rtPos = interpolatedPositions[train.tripId];
          position = {
            lat: rtPos.lat,
            lng: rtPos.lng,
            fromStation: rtPos.from_stop_id || '現在位置',
            toStation: rtPos.to_stop_id || train.headsign,
            progress: 0.5,
            isMoving: rtPos.status === 'IN_TRANSIT_TO',
            source: 'realtime',
            timestamp: rtPos.timestamp,
            status: rtPos.status
          };
        } else {
          // 時刻表ベースの位置計算
          position = calculateScheduledPosition(train.schedule, stopsMap, currentTime);
        }

        return position ? { ...train, position } : null;
      })
      .filter(Boolean);
  };

  const trainPositions = getCurrentTrainPositions();

  // デバッグ用: グローバルに公開
  useEffect(() => {
    window.DEBUG = {
      realtimePositions,
      interpolatedPositions,
      trains,
      trainPositions,
      realtimeMode,
      liveConnected,
      selectedRoute,
      stopsMap,
      routesMap
    };
  }, [realtimePositions, interpolatedPositions, trains, trainPositions, realtimeMode, liveConnected, selectedRoute]);

  const getRouteStations = () => {
    if (!selectedRoute || trains.length === 0) return [];

    const routeTrains = trains.filter(t => t.routeId === selectedRoute);
    if (routeTrains.length === 0) return [];

    const stationIds = new Set();
    routeTrains[0].schedule.forEach(stop => {
      if (stopsMap[stop.stopId]) {
        stationIds.add(stop.stopId);
      }
    });

    return Array.from(stationIds).map(id => stopsMap[id]).filter(Boolean);
  };

  const routeStations = getRouteStations();

  // 地図の境界計算
  const bounds = (() => {
    // リアルタイムモードの場合、表示中の列車から範囲を計算
    if (realtimeMode && trainPositions.length > 0) {
      const lats = trainPositions.map(t => t.position?.lat).filter(Boolean);
      const lngs = trainPositions.map(t => t.position?.lng).filter(Boolean);

      if (lats.length > 0 && lngs.length > 0) {
        return {
          minLat: Math.min(...lats) - 0.1,
          maxLat: Math.max(...lats) + 0.1,
          minLng: Math.min(...lngs) - 0.1,
          maxLng: Math.max(...lngs) + 0.1,
        };
      }
    }

    // 時刻表モード（既存ロジック）
    if (routeStations.length > 0) {
      return {
        minLat: Math.min(...routeStations.map(s => s.lat)) - 0.01,
        maxLat: Math.max(...routeStations.map(s => s.lat)) + 0.01,
        minLng: Math.min(...routeStations.map(s => s.lng)) - 0.01,
        maxLng: Math.max(...routeStations.map(s => s.lng)) + 0.01,
      };
    }

    return null;
  })();

  // 座標変換
  const latLngToCanvas = (lat, lng, width, height) => {
    if (!bounds) return { x: 0, y: 0 };
    const x = ((lng - bounds.minLng) / (bounds.maxLng - bounds.minLng)) * width;
    const y = height - ((lat - bounds.minLat) / (bounds.maxLat - bounds.minLat)) * height;
    return { x, y };
  };

  // 時刻表モードの時間進行
  useEffect(() => {
    if (!isPlaying || realtimeMode) return;
    const interval = setInterval(() => {
      setCurrentTime(prev => (prev + 1) % 86400);
    }, 100);
    return () => clearInterval(interval);
  }, [isPlaying, realtimeMode]);

  // Canvas描画
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || routeStations.length === 0) return;

    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    ctx.fillStyle = '#f5f5f5';
    ctx.fillRect(0, 0, width, height);

    // 路線描画
    const routeColor = routesMap[selectedRoute]?.color || '#4CAF50';
    ctx.strokeStyle = routeColor;
    ctx.lineWidth = 4;
    ctx.beginPath();
    routeStations.forEach((station, i) => {
      const pos = latLngToCanvas(station.lat, station.lng, width, height);
      if (i === 0) ctx.moveTo(pos.x, pos.y);
      else ctx.lineTo(pos.x, pos.y);
    });
    ctx.stroke();

    // 駅描画
    routeStations.forEach(station => {
      const pos = latLngToCanvas(station.lat, station.lng, width, height);
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#333';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(station.name, pos.x, pos.y - 12);
    });

    // 列車描画
    trainPositions.forEach((train, idx) => {
      if (train.position) {
        const pos = latLngToCanvas(train.position.lat, train.position.lng, width, height);
        const source = train.position.source || 'unknown';

        // 色分け：
        // - 'interpolated': 緑（時刻表ベースの補間）
        // - 'schedule': 黄（駅停車中）
        // - 'realtime': 青（リアルタイム）
        // - 'fallback': グレー（フォールバック）
        let trainColor = '#4CAF50'; // デフォルトは緑
        let showRipple = false;

        if (source === 'interpolated') {
          trainColor = '#4CAF50'; // 緑：時刻表補間
          showRipple = true;
        } else if (source === 'schedule') {
          trainColor = '#FFC107'; // 黄：駅停車中
        } else if (source === 'realtime') {
          trainColor = '#2196F3'; // 青：リアルタイム
          showRipple = true;
        } else if (source === 'fallback') {
          trainColor = '#9E9E9E'; // グレー：フォールバック
        }

        // 波紋エフェクト（補間中の列車のみ）
        if (showRipple && realtimeMode) {
          const now = Date.now() / 1000;
          const age = now - (lastSeenByTrip[train.tripId] || now);
          const freshness = Math.max(0, 1 - age / 5); // 5秒で薄くなる

          ctx.fillStyle = `${trainColor}33`; // 透明度20%
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, 16, 0, Math.PI * 2);
          ctx.fill();
        }

        // 列車本体
        ctx.fillStyle = trainColor;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // ホバー時のハイライト
        if (hoveredTrain === idx) {
          ctx.strokeStyle = '#FFD700';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, 12, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    });
  }, [currentTime, routeStations, trainPositions, hoveredTrain, selectedRoute, realtimeMode, lastSeenByTrip]);

  // マウス操作
  const handleMouseMove = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    setMousePos({ x: e.clientX, y: e.clientY });

    let found = null;
    trainPositions.forEach((train, idx) => {
      if (train.position) {
        const pos = latLngToCanvas(train.position.lat, train.position.lng, canvas.width, canvas.height);
        const dist = Math.sqrt(Math.pow(mouseX - pos.x, 2) + Math.pow(mouseY - pos.y, 2));
        if (dist < 12) found = idx;
      }
    });
    setHoveredTrain(found);
  };

  return (
    <div className="w-full h-screen bg-gray-100 flex flex-col">
      {/* ヘッダー */}
      <div className="bg-white shadow-md p-4">
        <h1 className="text-2xl font-bold text-gray-800 mb-3">
          JR東日本 SSEリアルタイム電車マップ
        </h1>
        <div className="flex items-center gap-3 flex-wrap mb-2">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsPlaying(!isPlaying)}
              className="p-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:bg-gray-300"
              disabled={realtimeMode}
            >
              {isPlaying ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <button
              onClick={() => setCurrentTime(timeToSeconds('09:00:00'))}
              className="p-2 bg-gray-500 text-white rounded hover:bg-gray-600"
            >
              <RotateCcw size={18} />
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-3 py-2 bg-green-500 text-white rounded hover:bg-green-600"
              disabled={loading}
            >
              {loading ? <Loader size={18} className="animate-spin" /> : <Upload size={18} />}
              GTFS
            </button>
            {!realtimeMode ? (
              <button
                onClick={connectLive}
                className="flex items-center gap-2 px-3 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
              >
                <Wifi size={18} />
                LIVE接続
              </button>
            ) : (
              <button
                onClick={disconnectLive}
                className="flex items-center gap-2 px-3 py-2 bg-red-500 text-white rounded hover:bg-red-600"
              >
                <WifiOff size={18} />
                切断
              </button>
            )}
            <input ref={fileInputRef} type="file" multiple accept=".json" onChange={handleFileUpload} className="hidden" />
          </div>

          {!realtimeMode && (
            <div className="text-lg font-mono bg-gray-100 px-3 py-1.5 rounded">
              {secondsToTime(currentTime)}
            </div>
          )}

          {Object.keys(routesMap).length > 1 && (
            <div className="flex items-center gap-2">
              <label className="text-sm font-semibold">路線:</label>
              <select
                value={selectedRoute || ''}
                onChange={(e) => setSelectedRoute(e.target.value)}
                className="px-3 py-1.5 border rounded text-sm"
              >
                <option value="">全路線</option>
                {Object.values(routesMap).map(route => (
                  <option key={route.id} value={route.id}>{route.name}</option>
                ))}
              </select>
            </div>
          )}

          <div className="flex items-center gap-2 ml-auto text-sm">
            {liveConnected ? (
              <div className="flex items-center gap-1 text-blue-600 font-semibold animate-pulse">
                <Wifi size={16} />
                <span>LIVE</span>
              </div>
            ) : realtimeMode ? (
              <div className="flex items-center gap-1 text-orange-600">
                <AlertCircle size={16} />
                <span>再接続中...</span>
              </div>
            ) : (
              <div className="flex items-center gap-1 text-gray-600">
                <WifiOff size={16} />
                <span>オフライン</span>
              </div>
            )}
            <span>|</span>
            <Database size={16} />
            <span>{trainPositions.length}編成</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="text"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder="サーバーURL"
            className="px-3 py-1 border rounded text-sm flex-1 max-w-xs"
          />
          <div className="text-sm text-gray-600 flex-1">{status}</div>
        </div>
      </div>

      {/* マップ */}
      <div className="flex-1 relative">
        {routeStations.length > 0 ? (
          <>
            <canvas
              ref={canvasRef}
              width={1200}
              height={800}
              className="w-full h-full cursor-pointer"
              onMouseMove={handleMouseMove}
              onMouseLeave={() => setHoveredTrain(null)}
            />

            {/* ツールチップ */}
            {hoveredTrain !== null && trainPositions[hoveredTrain] && (
              <div
                className="absolute bg-white shadow-lg rounded-lg p-3 pointer-events-none z-10 border"
                style={{ left: mousePos.x + 15, top: mousePos.y + 15 }}
              >
                {(() => {
                  const train = trainPositions[hoveredTrain];
                  const isRealtime = train.position.source === 'realtime';
                  const age = isRealtime ? (Date.now() / 1000 - (lastSeenByTrip[train.tripId] || 0)) : 0;

                  const source = train.position.source || 'unknown';
                  const sourceLabels = {
                    'interpolated': '時刻表補間',
                    'schedule': '駅停車中',
                    'realtime': 'リアルタイム',
                    'fallback': 'フォールバック',
                    'unknown': '不明'
                  };

                  return (
                    <div className="text-sm">
                      <div className="flex items-center gap-2 mb-1">
                        <div className="font-bold">{routesMap[train.routeId]?.name}</div>
                        <div className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded ${
                          source === 'interpolated' ? 'bg-green-100 text-green-700' :
                          source === 'schedule' ? 'bg-yellow-100 text-yellow-700' :
                          source === 'realtime' ? 'bg-blue-100 text-blue-700' :
                          'bg-gray-100 text-gray-700'
                        }`}>
                          {source === 'interpolated' || source === 'realtime' ? <Wifi size={12} /> : null}
                          {sourceLabels[source]}
                        </div>
                      </div>
                      <div className="space-y-0.5">
                        <div><span className="font-semibold">行先:</span> {train.headsign}</div>
                        <div><span className="font-semibold">Trip:</span> {train.tripId}</div>
                        {train.position.fromStation && (
                          <div><span className="font-semibold">区間:</span> {train.position.fromStation} → {train.position.toStation}</div>
                        )}
                        {train.position.progress !== undefined && (
                          <div><span className="font-semibold">進捗:</span> {(train.position.progress * 100).toFixed(1)}%</div>
                        )}
                        {train.position.delay !== undefined && train.position.delay !== 0 && (
                          <div className={train.position.delay > 0 ? 'text-red-600' : 'text-blue-600'}>
                            <span className="font-semibold">遅延:</span> {train.position.delay > 0 ? '+' : ''}{train.position.delay}秒
                          </div>
                        )}
                        <div className="text-xs text-gray-500 mt-1">
                          位置: {train.position.lat.toFixed(5)}, {train.position.lng.toFixed(5)}
                        </div>
                        {isRealtime && (
                          <div className="text-xs text-gray-500">
                            鮮度: {age.toFixed(1)}秒前
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}
          </>
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center text-gray-500">
              <Database size={48} className="mx-auto mb-4" />
              <p className="text-lg mb-2">GTFSデータを読み込んでください</p>
              <p className="text-sm">stops.json, routes.json, trips.json, stop_times.json</p>
            </div>
          </div>
        )}
      </div>

      {/* フッター */}
      <div className="bg-white border-t p-3">
        <div className="max-w-6xl mx-auto text-sm">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <p className="font-semibold mb-1">📡 SSE接続:</p>
              <ul className="text-xs space-y-0.5 text-gray-700">
                <li>• EventSource で自動受信</li>
                <li>• 3秒毎スナップショット</li>
                <li>• 1秒毎ハートビート</li>
                <li>• 自動再接続機能</li>
              </ul>
            </div>
            <div>
              <p className="font-semibold mb-1">🎯 位置補間:</p>
              <ul className="text-xs space-y-0.5 text-gray-700">
                <li>• 時刻表ベースで駅間補間</li>
                <li>• 60fps連続アニメーション</li>
                <li>• 遅延を反映した位置計算</li>
                <li>• TTL 15秒で鮮度判定</li>
              </ul>
            </div>
            <div>
              <p className="font-semibold mb-1">🎨 表示色:</p>
              <ul className="text-xs space-y-0.5 text-gray-700">
                <li>🟢 緑 = 時刻表補間（駅間）</li>
                <li>🟡 黄 = 駅停車中</li>
                <li>🔵 青 = リアルタイム</li>
                <li>⚫ グレー = フォールバック</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TokyoTrainMap2D;