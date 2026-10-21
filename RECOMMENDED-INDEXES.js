// 권장 MongoDB 인덱스 (코드 리뷰 에이전트 A 분석 결과)
//
// 서버는 시작할 때 server/src/db.js의 connect()에서 이 인덱스를 모두 자동으로 만듭니다.
// 이 파일은 참고용이며, 수동으로 만들 때는 mongosh에서 실행하세요:
//   mongosh "mongodb://<host>:27017/cc_usage" RECOMMENDED-INDEXES.js

// daily: 사용자 + 머신(machineId + hostname) + 날짜당 한 문서. 업로드 시 기간 단위 교체와 사용자 필터 조회에 사용
// (복제한 Linux 이미지는 /etc/machine-id가 같아서 hostname도 키에 넣음. 예전 { user, machineId, date } 인덱스는 서버가 지움)
db.daily.createIndex({ user: 1, machineId: 1, hostname: 1, date: 1 }, { unique: true });
// daily: 전체 사용자 기간 조회 (대시보드, 엑셀)
db.daily.createIndex({ date: 1 });
// daily: 전체 기간 사용자 순위(listUsers)를 문서를 읽지 않고 인덱스만으로 계산
db.daily.createIndex({ user: 1, totalTokens: 1 });

// users: 사용자별 최신 표시 이름
db.users.createIndex({ user: 1 }, { unique: true });

// reports: 최근 보고 이력
db.reports.createIndex({ receivedAt: -1 });
// reports: 머신별 최신 보고 (대시보드 머신 목록 집계가 정렬 없이 이 인덱스를 사용)
db.reports.createIndex({ user: 1, machineId: 1, hostname: 1, receivedAt: -1 });
// reports: /api/reports?user=… 최신순
db.reports.createIndex({ user: 1, receivedAt: -1 });
// reports: /api/reports?machineId=… 최신순
db.reports.createIndex({ machineId: 1, receivedAt: -1 });
// reports: 엑셀 보고 이력 — 요청 기간과 겹치는 보고 찾기
db.reports.createIndex({ until: 1, since: 1 });
