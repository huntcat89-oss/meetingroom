# 회의실 예약

날짜·시작시간·소요시간을 고르면 **비어 있는 회의실을 자동으로 추천**해 주는 예약 페이지입니다. 플로우(Flow) 회의실 캘린더와 연동하며, 중복 예약을 막습니다.

4단계 위저드: **① 날짜·시간 → ② 회의실(자동 추천) → ③ 상세 정보 → ④ 확인**

회의실은 **층(14F / 5F)별로 묶어** 한 화면에 표시되고, 선택한 시간에 비어 있는 방을 위로 올려 추천합니다. 상세 정보는 **회의명 + 참석자**만 받습니다(예약자는 API 키 소유자 본인).

## 층·회의실 목록 (고정)

`app/app.js` 상단 `FLOORS` 배열에서 정합니다. `project` 는 플로우 프로젝트 번호(=일정 `colaboSrno`), `rooms` 는 고정 회의실 목록(설정 화면에도 표시됨).

```js
const FLOORS = [
  { label: '14F', project: '1635267', rooms: [
    { id: '서울', loc: '대회의실' }, { id: '런던', loc: 'SaaS 사업부 옆' },
    { id: '도쿄', loc: '부대표실 옆' }, { id: '샌프란', loc: '입구(우)' },
    { id: '멕시코시티', loc: '입구(좌)' }, { id: '독도', loc: '화상회의실' },
    { id: '울릉도', loc: '화상회의실' }, { id: '스튜디오', loc: '진실의방' },
  ]},
  { label: '5F', project: '1555837', rooms: [
    { id: 'N', loc: '뉴욕 · 입구(좌)' }, { id: 'F', loc: '프랑크푸르트 · 입구(우)' },
    { id: 'FG', loc: '플레이 그라운드' }, { id: '510 스튜디오', loc: '' },
  ]},
];
```

각 방에 `zone: 'A'` 처럼 구역을 넣으면 목록에 배지로 표시됩니다(A/B/C 구역 정보 주시면 반영). 층 필터는 일정 `colaboSrno` 로 잡습니다.

## 배포 (GitHub Pages)

정적 사이트는 `app/` 에 있고, `.github/workflows/pages.yml` 이 이 폴더를 Pages 로 배포합니다.

1. 이 저장소를 GitHub 에 push (main 브랜치)
2. Settings → Pages → Source: **GitHub Actions** 선택
3. Actions 워크플로가 끝나면 발급된 주소로 접속 (이후 push 마다 자동 재배포)

`app/` 만 배포되므로 루트의 `.env`(로컬 서버용 키)는 절대 공개되지 않습니다.

## 데이터 연결

우측 하단 **연결 설정**에서 정합니다.

- **샘플 데모 (기본)** — 키 없이 바로 동작. UI·자동추천·중복검사 흐름을 그대로 체험. 실제 예약은 생성되지 않음.
- **플로우 실데이터** — **개인용** 플로우 API 키를 입력하면 브라우저가 플로우 `user` API 를 직접 호출합니다. **키는 이 브라우저(localStorage)에만 저장**되고 서버·저장소로 전송되지 않습니다(브라우저 저장소를 지우지 않는 한 유지).
  - 베이스 URL 기본값: `https://api.flow.team` (경로에 `/user` 는 앱이 자동으로 붙임)
  - 사용하는 API: 일정 조회·생성 [`/user/calendars/events`](https://api.flow.team/docs/api/user/calendars), 참석자 검색용 구성원 [`/user/employees`](https://api.flow.team/docs/api/user/employees)
  - 예약 생성 캘린더는 층 프로젝트(`colaboSrno`)로 `/calendars` 에서 자동 역매핑합니다.

> ⚠️ **CORS 주의**: 브라우저에서 `api.flow.team` 직접 호출은 플로우 서버가 CORS 를 허용해야 동작합니다. 설정의 **연결 테스트**로 확인하세요. 차단되면 아래 로컬 서버(프록시)를 쓰세요.

## 로컬 서버 (선택 · CORS 우회, 실예약)

`server.py` 는 같은 UI 를 로컬에서 띄우고 플로우 API 를 서버측에서 프록시합니다. 의존성 없음(Python 표준 라이브러리).

```bash
cp .env.example .env      # FLOW_API_KEY 채우기
python3 server.py         # http://localhost:5173  (app/ 를 서빙)
```

## 파일

| 경로 | 역할 |
|------|------|
| `app/index.html` · `app/styles.css` · `app/app.js` | 정적 위저드 앱 (GitHub Pages) |
| `app/.nojekyll` | Pages 가 자산을 그대로 서빙하도록 |
| `server.py` | 선택적 로컬 서버 + 플로우 API 프록시 |
| `.env.example` | 로컬 서버용 환경변수 예시 |

## 예약 규칙

일정 제목은 `[회의실명] 회의명` 으로 저장됩니다(플로우 관례). 참석자는 일정 본문에 기록됩니다.

## 방문 분석 (몇 명이 쓰는지)

GitHub Pages는 정적 사이트라 서버 로그가 없어, **Google Analytics 4(GA4)**로 접속자·예약 수를 집계합니다.

1. [analytics.google.com](https://analytics.google.com) → 속성 만들기 → 웹 스트림 생성 → **측정 ID**(`G-XXXXXXXXXX`) 확보
2. `app/index.html` 상단의 `window.MR_GA_ID = "";` 에 측정 ID를 넣기
3. 배포 후 GA4 실시간/보고서에서 **활성 사용자·페이지뷰** 확인. 예약 완료 시 `booking_confirmed` 커스텀 이벤트(층·회의실 포함)가 전송돼 실제 사용량도 볼 수 있음

> ID를 비워두면 분석 스크립트를 전혀 로드하지 않습니다. 저장소 방문 통계만 필요하면 GitHub 저장소 → Insights → Traffic 도 참고. 쿠키 배너 없는 대안으로는 GoatCounter·Plausible 등이 있습니다.

## 참석자

`/user/employees` 로 구성원을 불러와 이름으로 검색·선택합니다. 예약 생성 시 선택된 구성원은 `attendances`(userId)로 첨부를 시도하고, 실패하면 일정 본문에 이름으로 기록합니다(생성 자체는 항상 성공).

## 다음 단계

- A/B/C 구역 정보가 확정되면 각 방 `zone` 에 반영 (목록·카드에 배지 표시)
- 참석자 `attendances` 페이로드 형식을 실 계정으로 검증(현재는 `{userId}` 시도 + 본문 폴백)
