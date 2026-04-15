# Pingo 🔔

> GitLab MR 감지 → Windows 트레이 토스트 알림 → Claude AI 코드 리뷰

GitLab Merge Request가 열리면 Windows 트레이에 알림을 띄우고, 클릭 한 번으로 Claude CLI 기반 AI 코드 리뷰를 스트리밍으로 받을 수 있는 Electron 트레이 앱입니다.

---

## 주요 기능

- **트레이 상주** — 백그라운드에서 30초마다 GitLab MR 폴링
- **Windows 토스트 알림** — 새 MR 감지 시 알림 발송 (MR 열기 / AI 리뷰 버튼)
- **AI 코드 리뷰** — Claude CLI(`claude -p`) 스트리밍 호출, 마크다운 실시간 렌더링
- **인앱 diff 모달** — 변경 파일별 unified diff 뷰어
- **GitLab 댓글 등록** — AI 리뷰 결과를 MR Discussions에 바로 등록
- **알림 토글** — 트레이 메뉴에서 ACTIVE ↔ MUTED 전환

## 트레이 상태

| 아이콘 | 상태 | 설명 |
|--------|------|------|
| 🟢 초록 | ACTIVE | 정상 폴링 중 |
| 🔴 빨강 | MUTED | 알림 꺼짐 (폴링은 유지) |
| 🟡 노랑 (깜빡) | NEW_MR | 새 MR 있음 |
| ⚫ 회색 | ERROR | GitLab 연결 실패 |

---

## 설치 및 실행

### 사전 요구사항

- [Node.js](https://nodejs.org/) 18+
- [Claude Code CLI](https://claude.ai/code) (`claude` 명령이 PATH에 있어야 함)
- GitLab Personal Access Token (`read_api` 권한)

### 설치

```bash
git clone https://github.com/22noH/PinGo.git
cd PinGo
npm install
```

### 환경 설정

`.env.example`을 복사해 `.env` 파일을 만들고 값을 입력합니다.

```bash
cp .env.example .env
```

```env
GITLAB_URL=https://your-gitlab.com
GITLAB_TOKEN=glpat-xxxx
GITLAB_USER_ID=123
POLL_INTERVAL_MS=30000
```

> 앱 실행 후 트레이 → ⚙️ 설정에서도 변경 가능합니다.

### 아이콘 생성

```bash
npm run generate-icons
```

### 개발 실행

```bash
npm run dev
```

### 프로덕션 빌드 (Windows NSIS 인스톨러)

```bash
npm run dist
# release/ 폴더에 인스톨러 생성
```

---

## 사용 방법

1. 앱 실행 → 시스템 트레이에 Pingo 아이콘 표시
2. **첫 실행**: 설정 창이 자동으로 열립니다. GitLab URL, 토큰, User ID 입력 후 저장
3. **MR 감지**: 리뷰어로 지정된 MR이 열리면 토스트 알림 발송
   - **[MR 열기]** → 브라우저에서 GitLab MR 페이지 오픈
   - **[AI 리뷰]** → 리뷰 윈도우 오픈
4. **리뷰 윈도우**:
   - 변경 파일 목록 확인 → 파일 클릭 시 인앱 diff 모달
   - [리뷰 시작] → Claude AI 스트리밍 리뷰
   - [GitLab 댓글 등록] → MR Discussions에 리뷰 내용 게시

---

## 프로젝트 구조

```
src/
├── main/
│   ├── main.ts          # 앱 생명주기
│   ├── tray.ts          # 트레이 상태 머신
│   ├── poller.ts        # GitLab API 폴링
│   ├── notifier.ts      # 토스트 알림
│   ├── ipc.ts           # IPC 핸들러
│   ├── review-runner.ts # Claude CLI 스트리밍
│   └── store.ts         # electron-store 초기화
├── renderer/
│   ├── review/          # 리뷰 윈도우 (스트리밍 + diff 모달)
│   └── settings/        # 설정 윈도우
├── shared/
│   ├── types.ts         # 공유 타입 정의
│   └── constants.ts     # IPC 채널명 상수
└── preload.ts           # contextBridge API

assets/                  # 트레이 아이콘 SVG/PNG
scripts/
└── generate-icons.js    # SVG → PNG 변환
```

---

## 기술 스택

| 항목 | 기술 |
|------|------|
| Framework | Electron |
| Language | TypeScript (strict) |
| GitLab 연동 | axios + Personal Access Token 폴링 |
| AI 리뷰 | Claude Code CLI (`claude -p --output-format stream-json`) |
| 알림 | Electron Notification API |
| 스타일 | TailwindCSS CDN + 커스텀 CSS (Claude Desktop 다크테마) |
| 설정 저장 | electron-store |
| 로깅 | electron-log |

---

## 개발 정보

이 프로젝트는 **Claude Code Agent Team** 방식으로 개발되었습니다.

- **Orchestrator** — 전체 PM, 설계→구현→UI→리뷰 조율
- **Architect** — 타입/IPC/인터페이스 설계
- **Backend** — 메인 프로세스 구현
- **Frontend** — renderer UI 구현
- **Reviewer** — 보안/품질/IPC 계약 검증

`.claude/` 디렉토리에 각 에이전트의 역할 정의가 담겨있습니다.

---

## 라이선스

MIT
