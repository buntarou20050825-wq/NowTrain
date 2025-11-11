import React, { useState, useEffect, useRef, useCallback } from 'react';

const TrainMapComplete = () => {
    // ========== State管理 ==========
    const [stops, setStops] = useState([]);
    const [stopsMap, setStopsMap] = useState({});
    const [routes, setRoutes] = useState([]);
    const [trips, setTrips] = useState([]);
    const [stopTimes, setStopTimes] = useState([]);
    const [selectedRoute, setSelectedRoute] = useState('all');

    // ========== リアルタイムデータ管理 ==========
    const [realtimeMode, setRealtimeMode] = useState(false);
    const [liveConnected, setLiveConnected] = useState(false);
    const [serverUrl, setServerUrl] = useState('http://localhost:8000');
    const [realtimePositions, setRealtimePositions] = useState({});
    const [lastSeenByTrip, setLastSeenByTrip] = useState({});
    const [seqNum, setSeqNum] = useState(0);

    // ========== 補間アニメーション用 ==========
    const [timetablesCache, setTimetablesCache] = useState({});
    const [stationsCache, setStationsCache] = useState({});
    const [displayPositions, setDisplayPositions] = useState({});
    const animationFrameRef = useRef(null);

    const canvasRef = useRef(null);
    const eventSourceRef = useRef(null);

    // ========== GTFSからの時刻表キャッシュ構築 ==========
    useEffect(() => {
        if (stopTimes.length === 0 || stops.length === 0) return;

        console.log('[Timetables] Building cache from GTFS stop_times...');

        // stop_times.jsonをtrip_idでグループ化
        const timetables = {};
        stopTimes.forEach(st => {
            const tripId = st.trip_id;
            if (!timetables[tripId]) {
                timetables[tripId] = { stops: [] };
            }
            timetables[tripId].stops.push({
                stop_id: st.stop_id,
                arrival: st.arrival_time,
                departure: st.departure_time,
                sequence: parseInt(st.stop_sequence)
            });
        });

        // sequenceでソート
        Object.values(timetables).forEach(tt => {
            tt.stops.sort((a, b) => a.sequence - b.sequence);
        });

        setTimetablesCache(timetables);
        console.log('[Timetables] Built cache for', Object.keys(timetables).length, 'trips');

        // 駅座標キャッシュも構築
        const stationsMap = {};
        stops.forEach(stop => {
            stationsMap[stop.stop_id] = {
                lat: stop.stop_lat,
                lng: stop.stop_lon,
                name: stop.stop_name
            };
        });
        setStationsCache(stationsMap);
        console.log('[Stations] Cached', Object.keys(stationsMap).length, 'stations');
    }, [stopTimes, stops]);

    // ========== 時刻文字列を秒に変換 ==========
    const timeToSeconds = (timeStr) => {
        if (!timeStr) return 0;
        const [h, m, s] = timeStr.split(':').map(Number);
        return h * 3600 + m * 60 + (s || 0);
    };

    // ========== 現在時刻を秒に変換（当日の経過秒数） ==========
    const getTimeOfDayInSeconds = (date) => {
        const hours = date.getHours();
        const minutes = date.getMinutes();
        const seconds = date.getSeconds();
        return hours * 3600 + minutes * 60 + seconds;
    };

    // ========== 距離計算（km） ==========
    const getDistance = (pos1, pos2) => {
        if (!pos1 || !pos2) return 0;
        const R = 6371; // 地球の半径(km)
        const dLat = (pos2.lat - pos1.lat) * Math.PI / 180;
        const dLng = (pos2.lng - pos1.lng) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(pos1.lat * Math.PI / 180) * Math.cos(pos2.lat * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    };

    // ========== イージング関数 ==========
    const easeInOut = (t) => {
        return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    };

    // ========== trip_id正規化（ODPTとGTFSの突合せ用） ==========
    const normalizeTripId = (tripId) => {
        if (!tripId) return '';
        // "odpt.Train:JR-East.ChuoRapid.1092T.20251111" → "1092T"
        // または "JR-East.ChuoRapid.1092T" → "1092T"
        const parts = tripId.split('.');
        // 最後の要素が8桁の数字（日付）なら除外
        if (parts.length > 0 && parts[parts.length - 1].match(/^\d{8}$/)) {
            parts.pop();
        }
        // 列車番号部分を取得（最後の要素）
        return parts[parts.length - 1] || tripId;
    };

    // ========== 時刻表ベースの位置計算 ==========
    const calculateTimetablePosition = useCallback((tripId, now) => {
        // GTFSのtrip_idで検索
        let timetable = timetablesCache[tripId];

        // 見つからない場合、正規化して再検索
        if (!timetable) {
            const normalized = normalizeTripId(tripId);
            // すべてのtrip_idから正規化版が一致するものを探す
            const matchingTripId = Object.keys(timetablesCache).find(tid =>
                normalizeTripId(tid) === normalized
            );
            if (matchingTripId) {
                timetable = timetablesCache[matchingTripId];
            }
        }

        const realtime = realtimePositions[tripId];

        if (!timetable || !realtime || !realtime.from_stop_id) {
            return null;
        }

        const fromStationId = realtime.from_stop_id;
        const toStationId = realtime.to_stop_id;
        const delay = realtime.delay || 0;

        // 停車中の判定
        if (!toStationId || toStationId === 'null') {
            // from_stop_idをGTFS形式に変換
            // "odpt.Station:JR-East.ChuoRapid.Shinjuku" → stops.jsonのstop_idに変換
            const fromPos = findStationPos(fromStationId);
            if (fromPos) {
                return {
                    lat: fromPos.lat,
                    lng: fromPos.lng,
                    progress: 0,
                    status: 'stopped'
                };
            }
        }

        // 時刻表から出発・到着時刻を取得
        const stops = timetable.stops || [];

        // ODPT形式のstop_idをGTFS形式に変換して検索
        const fromStop = stops.find(s => matchStopId(s.stop_id, fromStationId));
        const toStop = stops.find(s => matchStopId(s.stop_id, toStationId));

        if (!fromStop || !toStop) {
            return null;
        }

        // 駅座標を取得
        const fromPos = stationsCache[fromStop.stop_id];
        const toPos = stationsCache[toStop.stop_id];

        if (!fromPos || !toPos) {
            return null;
        }

        // 時刻を秒に変換（遅延を加算）
        const depTime = timeToSeconds(fromStop.departure || fromStop.arrival) + delay;
        const arrTime = timeToSeconds(toStop.arrival || toStop.departure) + delay;
        const currentTime = getTimeOfDayInSeconds(now);

        // 進捗率を計算
        const duration = arrTime - depTime;
        if (duration <= 0) {
            return { lat: fromPos.lat, lng: fromPos.lng, progress: 0, status: 'stopped' };
        }

        const progress = (currentTime - depTime) / duration;
        const clampedProgress = Math.max(0, Math.min(1, progress));

        // 線形補間
        return {
            lat: fromPos.lat + (toPos.lat - fromPos.lat) * clampedProgress,
            lng: fromPos.lng + (toPos.lng - fromPos.lng) * clampedProgress,
            progress: clampedProgress,
            status: 'moving'
        };
    }, [timetablesCache, realtimePositions, stationsCache]);

    // ========== stop_id のマッチング（ODPT ↔ GTFS） ==========
    const matchStopId = (gtfsStopId, odptStopId) => {
        if (!gtfsStopId || !odptStopId) return false;

        // 完全一致
        if (gtfsStopId === odptStopId) return true;

        // ODPT形式: "odpt.Station:JR-East.ChuoRapid.Shinjuku"
        // GTFS形式: "1001" など

        // 駅名で照合（stationsCacheを使用）
        const gtfsStation = stationsCache[gtfsStopId];
        if (gtfsStation && odptStopId.includes(gtfsStation.name)) {
            return true;
        }

        return false;
    };

    // ========== 駅位置を検索（ODPT ID → GTFS座標） ==========
    const findStationPos = (odptStationId) => {
        if (!odptStationId) return null;

        // ODPT形式: "odpt.Station:JR-East.ChuoRapid.Shinjuku"
        // 駅名部分を抽出
        const parts = odptStationId.split('.');
        const stationName = parts[parts.length - 1]; // "Shinjuku"

        // stops.jsonから駅名で検索
        const matchingStation = stops.find(stop =>
            stop.stop_name && (
                stop.stop_name.includes(stationName) ||
                stop.stop_name.replace(/\s/g, '').toLowerCase().includes(stationName.toLowerCase())
            )
        );

        if (matchingStation) {
            return {
                lat: matchingStation.stop_lat,
                lng: matchingStation.stop_lon,
                name: matchingStation.stop_name
            };
        }

        return null;
    };

    // ========== GTFS-RTスナップショット受信時の処理 ==========
    const onSnapshotReceived = useCallback((snapshot) => {
        const now = Date.now();
        const newRealtimePositions = {};
        const newLastSeen = { ...lastSeenByTrip };

        snapshot.vehicles.forEach(vehicle => {
            const tripId = vehicle.trip_id;
            newRealtimePositions[tripId] = vehicle;
            newLastSeen[tripId] = now;

            setDisplayPositions(prev => {
                const current = prev[tripId];

                if (vehicle.lat && vehicle.lng) {
                    // GTFS-RTに座標がある場合
                    if (current && current.mode === "timetable") {
                        // 予測位置と実位置の差を計算
                        const distance = getDistance(current, vehicle);

                        // 100m以上ずれていたら補正
                        if (distance > 0.1) {
                            console.log(`[${tripId}] Correcting position: ${(distance * 1000).toFixed(0)}m`);
                            return {
                                ...prev,
                                [tripId]: {
                                    lat: current.lat,
                                    lng: current.lng,
                                    mode: "correcting",
                                    correctionStart: now,
                                    correctionFrom: { lat: current.lat, lng: current.lng },
                                    correctionTo: { lat: vehicle.lat, lng: vehicle.lng }
                                }
                            };
                        }
                    } else {
                        // 新しい列車 or 既にGTFS-RT座標を使用中
                        return {
                            ...prev,
                            [tripId]: {
                                lat: vehicle.lat,
                                lng: vehicle.lng,
                                mode: "timetable"
                            }
                        };
                    }
                } else {
                    // GTFS-RTに座標がない場合は時刻表モードで初期化
                    if (!current) {
                        return {
                            ...prev,
                            [tripId]: {
                                lat: null,
                                lng: null,
                                mode: "timetable"
                            }
                        };
                    }
                }

                return prev;
            });
        });

        setRealtimePositions(newRealtimePositions);
        setLastSeenByTrip(newLastSeen);
        setSeqNum(snapshot.seq || 0);
    }, [lastSeenByTrip]);

    // ========== SSE接続 ==========
    const connectSSE = useCallback(() => {
        if (eventSourceRef.current) {
            eventSourceRef.current.close();
        }

        const url = `${serverUrl}/api/trains/stream`;
        console.log('[SSE] Connecting to:', url);

        const es = new EventSource(url);

        es.addEventListener('snapshot', (e) => {
            try {
                const data = JSON.parse(e.data);
                onSnapshotReceived(data);
            } catch (err) {
                console.error('[SSE] Parse error:', err);
            }
        });

        es.addEventListener('ping', (e) => {
            // ハートビート受信
        });

        es.onopen = () => {
            console.log('[SSE] Connected');
            setLiveConnected(true);
            setRealtimeMode(true);
        };

        es.onerror = () => {
            console.error('[SSE] Connection error');
            setLiveConnected(false);
            es.close();

            setTimeout(() => {
                if (realtimeMode) {
                    console.log('[SSE] Reconnecting...');
                    connectSSE();
                }
            }, 5000);
        };

        eventSourceRef.current = es;
    }, [serverUrl, realtimeMode, onSnapshotReceived]);

    // ========== LIVE接続トグル ==========
    const toggleLiveConnection = () => {
        if (realtimeMode) {
            if (eventSourceRef.current) {
                eventSourceRef.current.close();
                eventSourceRef.current = null;
            }
            setRealtimeMode(false);
            setLiveConnected(false);
            setRealtimePositions({});
            setDisplayPositions({});
        } else {
            if (stopTimes.length === 0) {
                alert('先にGTFSファイル（特にstop_times.json）を読み込んでください！');
                return;
            }
            connectSSE();
        }
    };

    // ========== 60fps描画ループ ==========
    const animate = useCallback(() => {
        const now = Date.now();
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        const rect = canvas.getBoundingClientRect();

        // デバイスピクセル比対応
        const dpr = window.devicePixelRatio || 1;
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);

        // 画面クリア
        ctx.clearRect(0, 0, rect.width, rect.height);

        // 地図範囲を計算
        let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
        let hasPositions = false;

        const updatedDisplayPositions = {};

        Object.entries(displayPositions).forEach(([tripId, display]) => {
            let drawPos = null;

            if (display.mode === "correcting") {
                // 補正中（1秒かけてスムーズに移動）
                const elapsed = now - display.correctionStart;
                const t = Math.min(1, elapsed / 1000);

                drawPos = {
                    lat: display.correctionFrom.lat +
                        (display.correctionTo.lat - display.correctionFrom.lat) * easeInOut(t),
                    lng: display.correctionFrom.lng +
                        (display.correctionTo.lng - display.correctionFrom.lng) * easeInOut(t)
                };

                updatedDisplayPositions[tripId] = {
                    ...display,
                    lat: drawPos.lat,
                    lng: drawPos.lng
                };

                // 補正完了
                if (t >= 1) {
                    updatedDisplayPositions[tripId].mode = "timetable";
                }
            } else {
                // 時刻表ベース補間
                const calculatedPos = calculateTimetablePosition(tripId, new Date());
                if (calculatedPos) {
                    drawPos = calculatedPos;
                    updatedDisplayPositions[tripId] = {
                        lat: drawPos.lat,
                        lng: drawPos.lng,
                        mode: "timetable"
                    };
                } else if (display.lat && display.lng) {
                    // フォールバック（既存の位置を使用）
                    drawPos = display;
                    updatedDisplayPositions[tripId] = display;
                }
            }

            if (drawPos && drawPos.lat && drawPos.lng) {
                hasPositions = true;
                minLat = Math.min(minLat, drawPos.lat);
                maxLat = Math.max(maxLat, drawPos.lat);
                minLng = Math.min(minLng, drawPos.lng);
                maxLng = Math.max(maxLng, drawPos.lng);
            }
        });

        // displayPositionsを更新（非同期的に）
        setDisplayPositions(updatedDisplayPositions);

        if (!hasPositions) {
            ctx.fillStyle = '#666';
            ctx.font = '14px sans-serif';
            ctx.fillText('列車データを取得中...', rect.width / 2 - 70, rect.height / 2);
            animationFrameRef.current = requestAnimationFrame(animate);
            return;
        }

        // 地図範囲にマージンを追加
        const latMargin = (maxLat - minLat) * 0.1 || 0.1;
        const lngMargin = (maxLng - minLng) * 0.1 || 0.1;
        minLat -= latMargin;
        maxLat += latMargin;
        minLng -= lngMargin;
        maxLng += lngMargin;

        // 座標変換関数
        const latToY = (lat) => {
            return rect.height - ((lat - minLat) / (maxLat - minLat)) * rect.height;
        };
        const lngToX = (lng) => {
            return ((lng - minLng) / (maxLng - minLng)) * rect.width;
        };

        // 列車を描画
        Object.entries(updatedDisplayPositions).forEach(([tripId, display]) => {
            if (!display.lat || !display.lng) return;

            const x = lngToX(display.lng);
            const y = latToY(display.lat);

            // TTLチェック（15秒以内のデータのみ表示）
            const lastSeen = lastSeenByTrip[tripId];
            const age = lastSeen ? (now - lastSeen) / 1000 : 999;
            if (age > 15) return;

            // 鮮度に応じた透明度
            const freshness = Math.max(0, 1 - age / 15);

            // 遅延に応じた色分け
            const realtime = realtimePositions[tripId];
            const delay = realtime?.delay || 0;
            let color = '#3B82F6'; // 青（定時）
            if (delay >= 300) {
                color = '#EF4444'; // 赤（5分以上遅延）
            } else if (delay >= 60) {
                color = '#F59E0B'; // 黄（1分以上遅延）
            }

            // 波紋エフェクト
            if (age < 3) {
                const rippleProgress = (age % 1);
                const rippleRadius = 15 + rippleProgress * 10;
                ctx.beginPath();
                ctx.arc(x, y, rippleRadius, 0, Math.PI * 2);
                ctx.strokeStyle = `${color}${Math.floor((1 - rippleProgress) * 0.5 * 255).toString(16).padStart(2, '0')}`;
                ctx.lineWidth = 2;
                ctx.stroke();
            }

            // 列車本体
            ctx.beginPath();
            ctx.arc(x, y, 6, 0, Math.PI * 2);
            ctx.fillStyle = `${color}${Math.floor(freshness * 255).toString(16).padStart(2, '0')}`;
            ctx.fill();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.stroke();
        });

        animationFrameRef.current = requestAnimationFrame(animate);
    }, [displayPositions, realtimePositions, lastSeenByTrip, calculateTimetablePosition]);

    // ========== アニメーション開始 ==========
    useEffect(() => {
        if (realtimeMode && liveConnected) {
            animationFrameRef.current = requestAnimationFrame(animate);
            return () => {
                if (animationFrameRef.current) {
                    cancelAnimationFrame(animationFrameRef.current);
                }
            };
        }
    }, [realtimeMode, liveConnected, animate]);

    // ========== クリーンアップ ==========
    useEffect(() => {
        return () => {
            if (eventSourceRef.current) {
                eventSourceRef.current.close();
            }
            if (animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
            }
        };
    }, []);

    // ========== GTFSファイル読み込み ==========
    const handleFileUpload = async (event) => {
        const files = Array.from(event.target.files);

        for (const file of files) {
            const text = await file.text();
            const data = JSON.parse(text);

            if (file.name.includes('stops')) {
                setStops(data);
                const map = {};
                data.forEach(stop => {
                    map[stop.stop_id] = stop;
                });
                setStopsMap(map);
                console.log('[GTFS] Loaded', data.length, 'stops');
            } else if (file.name.includes('routes')) {
                setRoutes(data);
                console.log('[GTFS] Loaded', data.length, 'routes');
            } else if (file.name.includes('trips')) {
                setTrips(data);
                console.log('[GTFS] Loaded', data.length, 'trips');
            } else if (file.name.includes('stop_times')) {
                setStopTimes(data);
                console.log('[GTFS] Loaded', data.length, 'stop_times');
            }
        }
    };

    // ========== デバッグ用 ==========
    useEffect(() => {
        window.DEBUG = {
            timetablesCache,
            stationsCache,
            displayPositions,
            realtimePositions,
            stopTimes
        };
    }, [timetablesCache, stationsCache, displayPositions, realtimePositions, stopTimes]);

    // ========== レンダリング ==========
    return (
        <div style={{ width: '100%', height: '100vh', background: '#1a1a1a', color: '#fff', fontFamily: 'sans-serif' }}>
            {/* ヘッダー */}
            <div style={{ padding: '15px', background: '#2a2a2a', borderBottom: '2px solid #3a3a3a' }}>
                <h1 style={{ margin: '0 0 15px 0', fontSize: '24px' }}>JR東日本 リアルタイム電車マップ（完全版）</h1>

                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
                    <button
                        onClick={() => document.getElementById('gtfs-upload').click()}
                        style={{
                            padding: '8px 16px',
                            background: '#4B5563',
                            border: 'none',
                            borderRadius: '4px',
                            color: '#fff',
                            cursor: 'pointer'
                        }}
                    >
                        📤 GTFS読込
                    </button>
                    <input
                        id="gtfs-upload"
                        type="file"
                        multiple
                        accept=".json"
                        onChange={handleFileUpload}
                        style={{ display: 'none' }}
                    />

                    <div style={{
                        padding: '8px 12px',
                        background: '#374151',
                        borderRadius: '4px',
                        fontSize: '12px'
                    }}>
                        時刻表: {Object.keys(timetablesCache).length}件 | 駅: {Object.keys(stationsCache).length}件
                    </div>

                    <input
                        type="text"
                        value={serverUrl}
                        onChange={(e) => setServerUrl(e.target.value)}
                        placeholder="http://localhost:8000"
                        style={{
                            padding: '8px',
                            background: '#374151',
                            border: '1px solid #4B5563',
                            borderRadius: '4px',
                            color: '#fff',
                            width: '200px'
                        }}
                    />

                    <button
                        onClick={toggleLiveConnection}
                        disabled={stopTimes.length === 0}
                        style={{
                            padding: '8px 16px',
                            background: stopTimes.length === 0 ? '#6B7280' : (realtimeMode ? '#EF4444' : '#10B981'),
                            border: 'none',
                            borderRadius: '4px',
                            color: '#fff',
                            cursor: stopTimes.length === 0 ? 'not-allowed' : 'pointer',
                            fontWeight: 'bold'
                        }}
                    >
                        {realtimeMode ? '📡 切断' : '📡 LIVE接続'}
                    </button>

                    <div style={{
                        padding: '8px 16px',
                        background: liveConnected ? '#10B981' : '#6B7280',
                        borderRadius: '4px',
                        fontSize: '14px'
                    }}>
                        {liveConnected ? `✓ LIVE: ${Object.keys(displayPositions).length}編成 (seq:${seqNum})` : '✗ オフライン'}
                    </div>
                </div>
            </div>

            {/* 地図キャンバス */}
            <canvas
                ref={canvasRef}
                style={{
                    width: '100%',
                    height: 'calc(100vh - 100px)',
                    background: '#f5f5f5',
                    display: 'block'
                }}
            />
        </div>
    );
};

export default TrainMapComplete;