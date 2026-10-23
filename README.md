# ccusage-web

팀원 각자의 컴퓨터에서 Claude Code와 Codex(ChatGPT 계정으로 쓰는 OpenAI Codex CLI) 사용량(토큰 수)을 모아 팀 통계로 보여주는 서비스입니다. 각 컴퓨터의 `cc-usage` 클라이언트가 [ccusage](https://github.com/ryoppippi/ccusage)로 사용량을 집계해 서버에 올리고, 서버는 MongoDB에 저장해 대시보드와 엑셀 보고서로 제공합니다.

## 주요 기능

- **사용량 수집 클라이언트(`cc-usage`)**: 한 줄 명령(`npx … setup`)으로 설치하고, 설정 저장·첫 전송·매일 자동 전송(macOS launchd, Linux cron, Windows 작업 스케줄러) 등록을 한 번에 처리합니다. 옵션 없이 실행하면 대화형으로 설정합니다.
- **대시보드**: 기간(7/30/90일, 직접 선택), 사용자, 에이전트(Claude Code / Codex) 필터로 총 토큰, 활성 사용자, 세션, 캐시 적중률, 일별 토큰(영역/막대), 사용자별 토큰량, 누적 사용량(처음 사용한 달부터 월별, 기간 선택과 무관), 사용자·머신 표를 보여줍니다.
- **에이전트별 수집**: Claude Code와 Codex 사용량을 에이전트별로 따로 저장합니다. 필터가 "전체 에이전트"이면 합산하고, 두 에이전트가 모두 쓰인 기간에는 사용자 표에 에이전트별 열을 보여줍니다. Codex를 쓰지 않는 컴퓨터는 Codex 0으로 보고됩니다.
- **사용량 추세**: 사용자마다 기간 내 일별 토큰의 추세선(선형 회귀) 기울기로 증가/일정/감소 그룹을 나누고, 그룹별 추세 차트와 사용자 목록을 보여줍니다.
- **여러 컴퓨터 합산**: 사용자 ID(이메일)와 머신 ID로 컴퓨터별로 저장하고 통계에서 합산합니다. 같은 기간을 다시 보내도 중복되지 않습니다.
- **한글 이름**: 사용자 ID와 별도로 표시 이름(예: 홍길동)을 보낼 수 있습니다.
- **엑셀 다운로드**: 현재 필터로 요약, 사용자별, 일별 합계, 사용자별 일별, 일별 토큰표, 추세 그룹, 머신, 보고 이력 8개 탭의 보고서를 받습니다.
- **클라이언트 설정 안내 창**: 대시보드의 "클라이언트 설정 방법" 버튼에서 이메일·이름을 넣으면 바로 복사할 설치 명령을 만들어 줍니다. 서버 주소는 `PUBLIC_URL` → (서버 컴퓨터에서 localhost로 열었다면) 서버의 네트워크 주소 → 지금 접속한 주소 순서로 자동으로 정하고, 직접 고를 수도 있습니다.
- **개인정보 최소 수집**: 에이전트별 토큰 수(입력·출력·캐시 생성·캐시 읽기)와 세션 수, 사용자 ID, 이름, 머신 ID(OS 식별자의 해시), 호스트 이름만 전송합니다. 비용, 프로젝트, 모델, 대화 내용은 보내지 않으며, 서버도 이전 클라이언트가 보낸 상세 정보는 버립니다.

## 기술 스택

- **언어**: JavaScript (Node.js 20.19+, ESM)
- **프레임워크**: Express 5
- **DB**: MongoDB (공식 `mongodb` 드라이버)
- **기타**: Chart.js(대시보드 차트), ExcelJS(엑셀 보고서), ccusage 20.0.37(클라이언트에 버전 고정)

## 설치 및 실행

### 사전 요구사항

- Node.js 20.19 이상 (서버, 배포 이미지는 node:20-alpine)
- MongoDB (Docker Manager 공유 서비스 또는 로컬)
- 클라이언트를 쓰는 컴퓨터: Node.js 20 이상

### 설치

저장소 루트에서 실행합니다.

```bash
npm install
```

### 환경변수 설정

`.env.example`을 복사하여 `.env` 파일을 생성하세요:

```bash
cp .env.example .env
```

| 변수 | 필수 | 설명 |
|------|------|------|
| `MONGODB_URI` | 예 | MongoDB 연결 문자열 (`MONGO_URL` 이름도 사용 가능). 배포: `mongodb://mongodb:27017/cc_usage`, 로컬: `mongodb://localhost:27017/<DB 이름>` |
| `MONGODB_DB` | 아니오 | DB 이름. 비우면 `MONGODB_URI`의 DB 이름, 그것도 없으면 `cc_usage` |
| `PORT` | 아니오 | 서버 포트 (기본 3000) |
| `HOST` | 아니오 | 바인딩 주소 (기본 0.0.0.0) |
| `INGEST_TOKEN` | 운영 시 권장 | 설정하면 업로드에 `Authorization: Bearer <토큰>`이 필요합니다 |
| `PUBLIC_URL` | 아니오 | 클라이언트가 접속할 서버 주소 (예: `https://tools.example.com/c/cc-usage`). 설정 안내 창의 예시 명령에 우선 사용 |
| `REPORT_TIMEZONE` | 아니오 | 엑셀 보고서의 시각 표시 시간대 (예: `Asia/Seoul`) |
| `ENTRA_TENANT_ID`, `ENTRA_API_CLIENT_ID` | 운영 시 필수 | Microsoft 회사 계정 로그인. 둘 다 넣으면 켜지고, 둘 다 비우면 로그인 없이 열립니다(하나만 넣으면 서버가 시작을 거부) |
| `ENTRA_SPA_CLIENT_ID`, `ENTRA_REQUIRED_SCOPE` | 아니오 | 화면용 앱 ID(기본: API 앱 ID), 필요한 범위 이름(기본 `access_as_user`) |
| `ADMIN_EMAILS` | 아니오 | 전원의 사용량을 보는 관리자 이메일(쉼표 구분). 나머지는 본인 사용량만 봅니다 |
| `EXPORT_EMAILS` | 아니오 | 엑셀 다운로드를 할 수 있는 이메일(쉼표 구분, 관리자와 별개). 비우면 `jyso@aircode.com` 만 |
| `CODEX_EMAILS` | 아니오 | Codex 사용량을 저장·표시할 사용자 ID(쉼표 구분). 그 밖의 사람 Codex 사용량은 받을 때 버리고 서버 시작 때 기존 것도 삭제. 비우면 `shhong@aircode.com` 만 |
| `ALLOWED_EMAIL_DOMAINS` | 운영 시 권장 | 로그인을 허용할 이메일 도메인(쉼표 구분). 비우면 테넌트의 게스트 계정도 로그인됩니다 |

### 로그인 (Microsoft 회사 계정)

`ENTRA_TENANT_ID`와 `ENTRA_API_CLIENT_ID`를 설정하면 대시보드가 로그인 화면부터 뜨고, 조회 API는 로그인한 사람의 토큰이 있어야 응답합니다.

- **권한**: `ADMIN_EMAILS`에 있는 사람은 전원의 사용량을, 그 밖의 사람은 본인 사용량만 봅니다. 본인 여부는 로그인 이메일과 클라이언트 설정 때 입력한 사용자 ID가 같은지로 판단하므로(대소문자 무시), 사용자 ID는 회사 이메일로 입력해야 합니다. 관리자가 아닌 사람의 설정 안내 창에는 로그인 이메일이 고정으로 채워집니다.
- **앱 등록**(Azure Portal, 이 대시보드 전용 단일 테넌트 앱 하나):
  1. 인증 → 플랫폼 **단일 페이지 애플리케이션(SPA)** → 리디렉션 URI에 대시보드 주소를 **끝 슬래시까지** 등록 (예: `https://tools.example.com/c/cc-usage/`)
  2. API 표시 → 애플리케이션 ID URI `api://<클라이언트 ID>` → 범위 `access_as_user` 추가(관리자 및 사용자 동의) → 같은 앱의 클라이언트 ID를 "권한 있는 클라이언트 애플리케이션"으로 추가
  3. 매니페스트의 `accessTokenAcceptedVersion`(또는 `requestedAccessTokenVersion`)을 `2`로 설정
  4. 테넌트 ID와 클라이언트 ID를 환경변수에 넣습니다. client secret은 만들지 않습니다(SPA + PKCE).
- **로그인 없이 열려 있는 것**: `/health`, `/api/health`, `/api/auth/config`, `/api/client-info`, 클라이언트 패키지, 그리고 업로드(`POST /api/reports` — 사람이 없는 자동 전송이라 `INGEST_TOKEN`으로 따로 막습니다).
- 배포 후 `GET /api/auth/config`의 `enabled`가 `true`인지 확인하세요. `false`면 로그인 없이 열려 있는 것입니다.

### 실행

```bash
npm start      # 운영 실행 (.env가 있으면 읽고, 이미 설정된 환경변수는 덮어쓰지 않음)
npm run dev    # 코드 변경 시 자동 재시작
```

실행 후 `http://localhost:3000` (또는 `.env`의 `PORT`)에서 대시보드를 엽니다. 헬스체크는 `GET /health`입니다.

UI 확인용 샘플 데이터(한글 이름의 `@sample.local` 사용자 40명, 그중 약 1/3은 Codex도 사용, 90일, 주간 업로드):

```bash
npm run seed:sample   # 다시 실행하면 같은 샘플로 교체
npm run seed:clean    # @sample.local 데이터만 삭제
```

### 클라이언트 설치 (각 컴퓨터)

대시보드의 **클라이언트 설정 방법** 버튼에서 명령을 복사하는 것이 가장 쉽습니다. 직접 실행하면:

```bash
npx --yes http://서버주소/client/cc-usage-client.tgz setup --user you@example.com --name 홍길동 --server http://서버주소
```

- `setup`만 입력하면 서버 주소, 사용자 ID, 이름, 토큰(필요 시), 자동 전송 시각을 차례로 묻습니다.
- 옵션: `--time HH:MM`(자동 전송 시각, 기본 13:00), `--no-schedule`(자동 전송 없이 설치), `--token`, `--dry-run`
- 설치 후 관리:

```bash
cc-usage status      # 설정, 자동 전송 등록 여부, 마지막 전송 결과, 새 버전 여부
cc-usage send        # 지금 최근 7일 보내기 (--days 30, --dry-run은 보낼 내용만 출력)
cc-usage uninstall   # 자동 전송 해제와 설치본 삭제 (--purge는 설정까지 삭제)
```

설정은 `~/.config/cc-usage/config.json`, 설치본은 `~/.local/share/cc-usage`(Windows는 `%LOCALAPPDATA%\cc-usage`)에 저장됩니다. 마지막으로 보낸 내용은 `~/.config/cc-usage/last-upload.json`에서 확인할 수 있습니다.

### API

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/api/reports` | 클라이언트 업로드 (`INGEST_TOKEN` 설정 시 Bearer 토큰 필요) |
| GET | `/api/stats?since=YYYY-MM-DD&until=YYYY-MM-DD[&user=][&agent=claude\|codex]` | 대시보드 통계 (최대 3년) |
| GET | `/api/export.xlsx?since=&until=[&user=][&agent=]` | 엑셀 보고서 |
| GET | `/api/reports[?user=&machineId=&limit=]`, `/api/reports/:id` | 보고 이력 |
| GET | `/api/users`, `/api/client-info` | 사용자 목록, 토큰 필요 여부와 클라이언트 패키지 경로 |
| GET | `/api/auth/config`, `/api/auth/me` | 로그인 설정(공개), 로그인한 사람의 이메일·역할·본인 사용자 ID |
| GET | `/health`, `/api/health` | 헬스체크 (`/api/health`는 DB 확인 포함) |

## 주의사항

- **Nginx 서브패스 환경**: Docker Manager에서는 `/c/프로젝트명/` 아래로 서비스됩니다. 대시보드의 리소스와 API 호출은 상대 경로를 쓰므로 절대 경로(`/`로 시작)를 추가하지 마세요. 설치 명령은 접속한 주소(서브패스 포함)를 기준으로 만들어집니다.
- **MongoDB 연결**: 서버는 포트를 먼저 열고 MongoDB에는 백그라운드에서 연결합니다(실패 시 2초~30초 간격으로 재시도). 연결 전까지 `/health`는 200, DB가 필요한 API와 `/api/health`는 503입니다. `MONGODB_URI`(또는 `MONGO_URL`)가 없으면 API가 설정 방법을 담은 503을 돌려줍니다. 컨테이너 안에서 호스트의 MongoDB에 붙을 때는 `localhost` 대신 `host.docker.internal`을 쓰세요.
- **업로드 인증**: 운영 환경에서는 `INGEST_TOKEN`을 반드시 설정하고, 서버는 HTTPS로만 노출하세요.
- **`.env` 파일을 Git에 커밋하지 마세요.** (`.gitignore`에 포함되어 있습니다)
- **클라이언트 패키지**: 서버가 `client/` 폴더를 `npm pack`으로 묶어 제공하므로 배포 이미지에 `client/` 폴더와 npm이 있어야 합니다. 패키지 파일은 다시 만들 수 있는 캐시라 영속 볼륨이 필요 없습니다.
- 모든 사용 데이터는 MongoDB에 저장되며 서버 컨테이너에는 영속 파일이 없습니다.

## 알려진 이슈

- `ENTRA_*`를 설정하지 않으면 대시보드와 조회 API가 인증 없이 공개됩니다.
- 사용자 ID는 클라이언트 설정 때 직접 입력한 값이라, 회사 이메일과 다르게 입력한 사람은 로그인해도 본인 사용량이 보이지 않습니다(그 이메일로 `setup`을 다시 실행해야 합니다). 대소문자만 다른 ID가 둘 이상이면 그중 하나만 본인 것으로 봅니다.
- `INGEST_TOKEN`은 팀 공용 토큰 하나라서, 토큰을 가진 사람은 다른 사용자 이름으로도 업로드할 수 있습니다.
- `/c/프로젝트명`처럼 끝 슬래시 없이 접속하면 리소스가 깨질 수 있습니다. 프록시가 `/c/프로젝트명/`으로 리다이렉트하는지 확인하세요.
- 업로드와 조회에 속도 제한이 없습니다.
- Windows 클라이언트의 설치·작업 스케줄러 등록은 실제 Windows에서 검증되지 않았습니다.
- Codex 사용량은 클라이언트 1.1.0부터 보냅니다. 이전 클라이언트는 Claude Code만 보내므로, 각 컴퓨터에서 `setup`을 다시 실행해야 Codex가 집계됩니다(대시보드 머신 표의 "수집 에이전트"로 확인).
- ChatGPT 웹/데스크톱 앱 사용량은 ccusage가 읽지 못하므로 집계되지 않습니다. Codex CLI(`~/.codex`) 사용량만 집계됩니다.
- 자세한 내용은 `IMPROVEMENTS.md`를 참고하세요.
