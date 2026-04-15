# pingo

## 프로젝트 목적
GitLab MR 생성/업데이트 감지 → Windows 트레이 토스트 알림 →
클릭 시 브라우저 오픈 or AI 리뷰 윈도우(Claude Desktop 스타일) 실행.
AI 리뷰는 Claude Code CLI(`claude -p`)를 호출하여 스트리밍으로 출력.

## 기술 스택
- Framework: Electron (최신 안정버전)
- Language: TypeScript (strict mode)
- Package Manager: npm
- GitLab: axios + Personal Access Token 폴링 (30초 간격)
- 알림: Electron Notification API (Windows 토스트)
- AI 리뷰: child_process.spawn('claude', ['-p', prompt])
- 스타일: TailwindCSS CDN + 커스텀 CSS (Claude Desktop 다크 테마)
- 설정 저장: electron-store
- 로깅: electron-log

## 디렉토리 구조
```
src/
├── main/
│   ├── main.ts          # Electron 메인 프로세스, 앱 생명주기
│   ├── tray.ts          # 트레이 아이콘 + 상태 관리 + 컨텍스트 메뉴
│   ├── poller.ts        # GitLab API 폴링 (30초 간격)
│   ├── notifier.ts      # Windows 토스트 알림 발송
│   └── ipc.ts           # IPC 핸들러 전체
├── renderer/
│   ├── review/
│   │   ├── index.html   # 리뷰 윈도우
│   │   ├── review.ts    # 리뷰 UI 로직
│   │   └── style.css    # Claude Desktop 스타일
│   └── settings/
│       ├── index.html   # 설정 윈도우
│       └── settings.ts  # 설정 저장/로드
├── shared/
│   ├── types.ts         # 공유 타입 정의
│   └── constants.ts     # IPC 채널명 상수
└── preload.ts           # contextBridge API

assets/
├── icon-active.png      # 🟢 정상 폴링 중
├── icon-muted.png       # 🔴 알림 꺼짐
├── icon-new-mr.png      # 🟡 새 MR 있음
└── icon-error.png       # ⚫ GitLab 연결 실패

scripts/
└── generate-icons.js    # SVG → PNG 아이콘 생성 스크립트
```

## 환경변수 (.env)
```
GITLAB_URL=https://your-gitlab.com
GITLAB_TOKEN=glpat-xxxx
GITLAB_USER_ID=123
POLL_INTERVAL_MS=30000
```

## 트레이 상태 머신
```
ACTIVE   → 정상 폴링 중        아이콘: icon-active.png   (초록)
MUTED    → 알림 꺼짐           아이콘: icon-muted.png    (빨강)
NEW_MR   → 새 MR 있음          아이콘: icon-new-mr.png   (노랑, 깜빡임)
ERROR    → GitLab 연결 실패    아이콘: icon-error.png    (검정)
```

## 트레이 우클릭 메뉴 구조
```
[상태 표시줄] "🟢 폴링 중 — 마지막 확인: 00:30전"  (비활성 텍스트)
──────────────────────────────
[토글] "🔔 알림 켜짐"  OR  "🔕 알림 꺼짐"  ← 클릭 시 ACTIVE/MUTED 토글
──────────────────────────────
[MR 목록 헤더] "최근 MR"  (비활성)
  MR #42  feat/login-refactor  (클릭 → 브라우저)
  MR #41  fix/session-bug      (클릭 → 브라우저)
  MR #40  chore/deps-update    (클릭 → 브라우저)
──────────────────────────────
⚙️  설정
──────────────────────────────
종료
```

## 핵심 플로우
1. 앱 시작 → 트레이 상주 (ACTIVE 상태)
2. 30초마다 GitLab API 폴링 (MUTED 상태면 알림만 스킵, 폴링은 유지)
3. 새 MR 감지 → seen ID 확인 → 토스트 발송
   - [MR 열기] → shell.openExternal(mr.web_url)
   - [AI 리뷰] → 리뷰 윈도우 오픈
4. 리뷰 윈도우
   - MR 정보 + 변경 파일 목록 표시
   - [리뷰 시작] → claude -p 스트리밍 호출
   - 결과 스트리밍 렌더링 (마크다운)
   - [GitLab 댓글 등록] → Discussions API

## Agent 통신 규칙
- 모든 Agent는 작업 전 agent-bus/ 전체 읽기
- 완료/보고는 자신의 agent-bus/{name}.md 에 기록
- STATUS: IN_PROGRESS / DONE / BLOCKED / REVIEW_REQUIRED
- 다른 Agent 파일 직접 수정 금지
- Orchestrator 지시 없이 다음 단계 진행 금지
- 불확실하면 추측 말고 BLOCKED + 질문 기록

## 금지사항
- any 타입 사용 금지
- console.log 금지 (electron-log 사용)
- 하드코딩 금지 (모두 .env or electron-store)
- 파일 300줄 초과 금지
- remote 모듈 사용 금지 (IPC 사용)
- nodeIntegration: true 금지
