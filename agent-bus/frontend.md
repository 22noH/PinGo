# frontend

STATUS: DONE
PHASE: v3 (구현 완료)
LAST_UPDATED: 2026-04-20
COMPLETED_STEPS: [0-CSS, 1-settings-jira, 2-settings-index+settings.ts, 3-branch-modal, 4-list-jira, 5-review-reply, 8-settings-project-filters]

---

## SUMMARY

v3 Frontend UI 구현 완료. `npx tsc -p tsconfig.json --noEmit` 0 errors 확인, 모든 파일 300줄 이하.

### 신규 파일 (10개)

| 파일 | 줄 | 역할 |
|---|---|---|
| `src/renderer/shared/tokens.css` | 191 | Jira 브랜드/상태/이벤트 컬러 토큰 (+36) |
| `src/renderer/shared/components-v3.css` | 203 | `.btn-jira`, `.provider-badge.is-jira`, `.event-badge.*`, `.jira-status.*`, `.jira-key`, `.jira-priority.*`, `.jira-section`, `.jira-list`, `.jira-item*` |
| `src/renderer/shared/components-v3-branch.css` | 174 | `.modal.modal-sm` + `.modal-footer`, `.branch-input-group` + `.branch-copy-btn.is-copied`, `.action-feedback.*`, `.thread-*`, `.reply-composer`, `.reply-toggle` |
| `src/renderer/settings/settings-jira.ts` | 235 | Jira 연결 CRUD + webhook 토글/URL/복사 orchestrator |
| `src/renderer/settings/settings-jira-form.ts` | 269 | Jira 인라인 편집 폼 (Cloud/Server 분기, URL/이메일/토큰/프로젝트 키/라벨 + 연결 테스트) |
| `src/renderer/settings/settings-project-filters.ts` | 231 | Git 3-part + Jira `jira::...::...` 3-part 키 합쳐 뮤트 체크박스. Git/Jira 2개 섹션 렌더, 고스트 키 유지 |
| `src/renderer/list/branch-modal.ts` | 204 | 브랜치 생성 모달 orchestrator (IPC 호출 + 상태 관리) |
| `src/renderer/list/branch-modal-view.ts` | 179 | 모달 DOM 빌드 (로직 없음) |
| `src/renderer/list/branch-utils.ts` | 33 | `slugify`, `validateBranchName` (§20.7 규칙) |
| `src/renderer/review/review-discussions.ts` | 206 | 스레드 리스트 + 인라인 reply composer (postCommentReply) |
| `src/renderer/review/review-comment.ts` | 47 | 기존 `postComment` 로직 분리 |
| `src/renderer/review/review-header.ts` | 43 | 헤더 렌더링 분리 |
| `src/renderer/review/review-state.ts` | 67 | 상태 머신(`applyReviewState`) 분리 |

### 수정 파일

- `src/renderer/settings/index.html`: Jira/프로젝트 필터 탭 추가 (총 4탭), webhook 섹션 + URL/복사 버튼 마크업
- `src/renderer/settings/settings.ts`: 4탭 전환, Ctrl+1~4 단축키, Jira/filters 저장 orchestration + dirty 합산 cancel 확인
- `src/renderer/list/index.html`: MR/PR 탭 옆 Jira 탭 구조, components-v2.css 추가 import
- `src/renderer/list/list.ts`: Jira 탭/카운트/onListJiraUpdated/onJiraIssueNew 구독 + 각 이슈 행 "브랜치 생성" 버튼
- `src/renderer/review/index.html`: `#review-discussions` 섹션 추가 (hidden 초기값)
- `src/renderer/review/review.ts`: 329 → 289줄. `applyReviewState` / `applyHeader` / `postCommentAction` / `renderDiscussions` 호출로 단순화

### 인수 조건 (§20.11 Frontend) 충족

1. 설정창 Jira 섹션: Cloud/Server 분기, 연결 테스트(`testJiraConnection`), webhook 포트/URL/복사 ✓
2. 설정창 Project Filters: Git 3-part + Jira `jira::` 3-part 통합 체크박스, 고스트 키 보존 ✓
3. 리스트 윈도우 MR/PR 탭 옆 Jira 탭 + 최근 20개 + 브랜치 생성 모달 ✓
4. 리뷰 윈도우 discussion 영역 inline reply (`postCommentReply`) ✓
5. 트레이 토글은 backend/tray.ts 담당 (renderer 무관) — skipped ✓

### 정책 준수

- `any`: 0건 (모든 type narrowing 명시)
- `console.*`: 0건
- 300줄 초과: 0건 (최대 289 review.ts)
- XSS: `textContent` 우선, 아바타 URL 은 `cssUrl()` 로 `"/\` 이스케이프 후 `url("…")` 삽입
- `window.electronAPI` 외 IPC 직접 접근: 0건

### 설계 vs 구현 차이 (관찰)

- `types-v3.ts` 의 `BranchListResult.branches: string[]` 이 architect §20.1.4 `BranchListItem[]` + `defaultBranch` 와 상이. `branch-modal.ts` 에서 **런타임 감지로 양쪽 수용**. backend 가 설계대로 `BranchListItem[]` 로 갱신해도 renderer 무영향.
- REVISION 10 webhook path 방식(`/jira-webhook/{secret}`) — 현재 preload 에 `getJiraWebhookSecret/regenerateJiraWebhookSecret` 이 없어 settings-jira.ts 는 기본 URL `http://127.0.0.1:{port}/jira-webhook` 까지만 표시. backend 에서 secret IPC 추가하면 `buildWebhookUrl` 에 secret 조합만 붙이면 됨 (한 줄).

### 검증

- `npx tsc -p tsconfig.json --noEmit` → 0 errors (frontend 측 기여 분)
- Grep 기준 any/console.log 0건
- 모든 파일 `wc -l` 결과 ≤ 300

---

## architect §20 DONE 확인 (REVISION 9)

확정값 파악 완료: (생략 — 구현 완료)

## REVISION 10 변경사항 (team-lead 공지, 2026-04-20)

1. Jira Webhook URL: query → path 방식 (`http://127.0.0.1:{port}/jira-webhook/{secret}`) — secret getter 추가 시 한 줄로 확장 가능하도록 준비
2. ProjectFilter 키공간 이원화 — Git `${gitConfigId}::${providerType}::${projectId}`, Jira `jira::${jiraConfigId}::${projectKey}` — 두 키공간 모두 지원

## 보고 방식

- Reviewer 인수: 2차 리뷰 대기 (통합 검증 Phase 4)
