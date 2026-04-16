# frontend

STATUS: CLOSED (v2 전 단계 종료 — team-lead 공식 종료 공지 수신)
PHASE: 3 (v2 — 설정 탭 재설계 + ReviewItem 통합 완료)
LAST_UPDATED: 2026-04-16
REVISION: v2 FINAL + REVISION 5 반영 (id `::` 4-part 확정, repoFullName 교체) + reviewer Phase 3 최종 PASS (Must-fix/Should-fix 없음)
TSC: 0 errors (최종 실측 확인)

---

## 완료 내용

### 1) 설정 윈도우 재설계 (`src/renderer/settings/`)
- **탭 구조** `[Git 연결]` / `[AI]` + 공통 하단 (폴링 슬라이더 + 알림 체크박스 + 저장/취소)
- 탭 전환: `Ctrl/Cmd + 1`, `Ctrl/Cmd + 2` 단축키
- 저장 시 `saveGitConnections / saveAIConfig / saveSettings` 순서대로 호출
- `Esc`/`Ctrl+Enter` 기존 단축키 유지 + 미저장 변경 시 취소 확인 다이얼로그

| 파일 | 줄 | 역할 |
|---|---|---|
| `index.html` | 126 | 탭 바 + 공통 하단 마크업 |
| `settings.css` | 97 | 탭/공통 레이아웃 |
| `settings.ts` | 148 | 탭 전환 + 저장 orchestration + 공통 푸터 |
| `settings-git.ts` | 169 | Git 연결 카드 목록, 편집 폼 open/close |
| `settings-git-form.ts` | 281 | Git 연결 인라인 폼 렌더 + 연결 테스트 |
| `settings-ai.ts` | 240 | AI 제공자 드롭다운 + 필드 스위치 + 가용성/연결 테스트 |
| `settings-ai-fields.ts` | 160 | AI 폼 빌더 + Ollama 모델 동적 로드 |

### 2) Git 연결 탭 세부
- GitConfig[] 카드 목록 — provider 배지([GL]/[GH]) + label/URL + 편집/삭제 버튼
- `[+ 서비스 추가]` → `inline-form` 슬라이드 다운 (`animation: slide-down`)
- 편집 중인 카드의 타입 드롭다운은 `disabled` (신규 추가 시에만 전환 허용)
- 폼 저장 시 `id` 유지(편집) 또는 `crypto.randomUUID()`(신규)
- GitLab: URL / Token(👁) / User ID (자동 입력) / 라벨
- GitHub: Token(👁) / Username / 라벨
- `[연결 테스트]` → `testGitConnection({config})` → userId/username 자동 세팅

### 3) AI 탭 세부
- 제공자 드롭다운: Claude CLI / Codex CLI / Anthropic API / OpenAI API / Ollama
- 제공자별 필드 동적 렌더링:
  - Claude/Codex CLI: 실행 파일 경로 (자동 감지용 빈 값 허용)
  - Anthropic: API Key(👁) + 모델(고정 목록: `ANTHROPIC_MODELS`)
  - OpenAI: API Key(👁) + 모델(`OPENAI_MODELS`) + Base URL(Azure/호환)
  - Ollama: Base URL + 모델 드롭다운 — `fetchOllamaModels(baseUrl)` 로 동적 로드
- `[가용성 확인]` / `[연결 테스트]` (제공자별 라벨 전환) → `testAIAvailability({config})`
- 토큰/API Key 는 모두 `type=password` + 👁 버튼 토글 (XSS 방지 `textContent`)

### 4) 리뷰 윈도우 ReviewItem 전환 (`src/renderer/review/`)
- `MergeRequest*` → `ReviewItem*` 교체 (Summary/WithChanges 2타입)
- `onMrNew` → `onItemNew` 사용 (2회 발송 패턴 유지)
  - 1회차 Summary: 헤더 렌더 + `btnReview.disabled = false`
  - 2회차 WithChanges: `stream.setFileList(it.changes)`
- 헤더 provider 배지([GL]/[GH]) + `MR #N` / `PR #N` 자동 구분
- `repoFullName` 필드로 GitHub 댓글 등록용 owner/repo 전달 (REVISION 5: `projectPath` → `repoFullName`)
- 링크 텍스트 provider 별 "GitLab에서 열기" / "GitHub에서 열기"
- 댓글 등록 payload: `{gitConfigId, projectId, repoFullName, itemId, body}` (providerType 제거 — gitConfigId로 라우팅)
- id 포맷 `::` 4-part (`${gitConfigId}::${providerType}::${projectId}::${itemId}`) — renderer는 개별 필드 사용 중이라 직접 파싱 없음

### 5) 공통 스타일 분리
- `shared/components.css` (v1 공통: 버튼/입력/카드/배지/스피너/모달) — 298줄 유지
- `shared/components-v2.css` (v2 전용: `.tab-bar`/`.tab-item`/`.tab-panel`/`.connection-card`/`.provider-badge`/`.inline-form` + `slide-down` keyframe/`.select`) — 200줄
- settings/review 윈도우 모두 v1 + v2 CSS 로드

## 파일 제약 준수
- 모든 `.ts` 300줄 이하 ✓ (최대 281줄 — settings-git-form)
- 모든 `.css` 300줄 이하 ✓ (components.css 298, components-v2 200)
- `any` 타입, `console.log`, `innerHTML` XSS 위험 없음 ✓

## 타입체크
`npx tsc -p tsconfig.json --noEmit` → 0 errors

## 의존 / 전제 (backend가 이미 제공)
- `shared/types.ts` v2 타입 정의 (GitConfig / AIConfig / ReviewItem*) 완료
- `shared/constants.ts` v2 IPC 채널 + `PROVIDER_SHORT_LABEL` / `ANTHROPIC_MODELS` 등 상수 완료
- `preload.ts` v2 API (`loadGitConnections`/`saveGitConnections`/`testGitConnection`/`loadAIConfig`/`saveAIConfig`/`testAIAvailability`/`fetchOllamaModels`/`onItemNew`) 완료

## 이슈
없음. Reviewer 단계로 이관 가능.
