# backend

STATUS: DONE (Phase 2 backend)
PHASE: 2 (v3 backend 구현 완료)
LAST_UPDATED: 2026-04-20

---

## v3 확장 착수

Orchestrator 킥오프 수신. v3 확장 백엔드 구현 시작.

### 시작 전 점검
- CLAUDE.md 정독 완료
- 팀 config 확인 완료 (architect, backend, team-lead)
- orchestrator.md v3 스펙 정독 완료
- 기존 v2 types.ts/constants.ts 파악 완료

### 블로커 (architect 설계 대기)
`architect.md` 최상단 STATUS 는 `IN_PROGRESS` 이고 REVISION 9 (v3) 설계가 **§20 이하** 에 기록 예정이라고 명시되어 있으나 현재 해당 섹션이 파일에 **없음** (v2 원본 REVISION 8 까지만 존재, 1484줄에서 종료).

v3 확장 구현의 100% 일치를 위해서는 architect 의 §20 이하 산출물이 필요:
- JiraConfig, JiraIssueSummary, JiraEventKind, PipelineInfo, GitIssue, BranchCreatePayload 등 신규 타입 정의
- v3 IPC 채널 (JIRA_ISSUE_NEW, LIST_JIRA_UPDATED, JIRA_CONNECTIONS_LOAD/SAVE/TEST, BRANCH_CREATE, BRANCH_LIST, COMMENT_REPLY, PROJECT_FILTERS_SAVE)
- GitProvider 인터페이스 v3 optional 메서드 시그니처
- Jira Webhook 수신기 엔드포인트/포트 스펙
- v2→v3 마이그레이션 기본값

### 다음 행동
architect 에게 SendMessage 로 v3 설계 §20 이하 완료 시점 및 현재 상태 확인 요청.
설계 수신 즉시 17개 파일 구현 시작.

---

## 선행조사 결과 (team-lead 지시 이행, 2026-04-20)

### 기존 v2 흐름 재숙지
- `src/main/poller.ts` (305줄): providers 병렬 폴링, 3가지 이벤트 (new_item/reviewer_assigned/new_comments) 탐지. v3 에서 Jira 폴링 루프 별도 + seen 에 pipelineIds/approvalItemIds/jiraIssueIds 추가.
- `src/main/notifier.ts` (105줄): reason별 title/body 분기. v3 에서 jira/pipeline/approval reason 추가.
- `src/main/tray.ts` (229줄): TrayController 메뉴. v3 Jira 이슈 섹션 추가 + `updateRecentJiraIssues` 메서드 필요.
- `src/main/ipc.ts` (352줄) **300줄 초과 중** — v3 에서 `ipc-jira.ts`, `ipc-branch.ts` 분리 필수 (orchestrator.md 설계 일치).
- `src/main/providers/git/git-provider.ts` (42줄): 인터페이스 7메서드, v3 optional 7개 추가 예정 (fetchRecentPipelines, fetchApprovalStatus, fetchAssignedIssues, fetchMentionedIssues, createBranch, listBranches, postReply).
- `src/main/providers/git/gitlab-provider.ts` (250줄): v3 메서드 추가 시 300줄 경계.
- `src/main/providers/git/github-provider.ts` (374줄) **300줄 초과 중** — v3 메서드는 별도 helper/mixin 파일로.

### v3 npm 패키지
- axios, dotenv, electron-log, electron-store, @anthropic-ai/sdk, openai 이미 존재.
- Jira REST API: axios 재사용 (Jira SDK 불필요)
- 웹훅 서버: Node.js 내장 `http` 모듈 (express 불필요)
- Basic Auth: Node 내장 `Buffer.from(...).toString('base64')`
- **신규 의존성 추가 불필요**

### 블로커 / 대기 중
- architect.md §20 v3 설계 미완성 (현재 §15.6 에서 종료)
- types.ts 343줄 / ipc.ts 352줄 / github-provider.ts 374줄 → v3 확장 전 architect 의 "파일 분할 방침" 확정 필요 (re-export 구조 or mixin)

---

## Phase 2 백엔드 구현 완료 (2026-04-20 후속)

architect §20 (REVISION 10, STATUS:DONE) 반영 완료. §20.13 체크리스트 11개 항목 모두 소화.

### 완료 항목
1. **shared/types 델타** — `StoreSchema.jiraWebhookToken?: string` (§20.13.I1), `ProjectFilter.projectKey` 3-part JSDoc (§20.13.I3), `BranchCreateResult.errorCode` enum, `CommentReplyPayload.threadContext/quoteAuthor/quoteSnippet` (§20.13.I5), `ItemEvent.issue?: GitIssue`.
2. **shared/constants 델타** — `JIRA_WEBHOOK_PATH_PREFIX='/jira-webhook/'`, `JIRA_WEBHOOK_BODY_LIMIT_BYTES=1_048_576`, `JIRA_WEBHOOK_REQUEST_TIMEOUT_MS=5_000`, `BRANCH_NAME_MAX_TOTAL_LEN=255`, `BRANCH_NAME_MAX_LEN` alias 유지. 기존 `JIRA_WEBHOOK_PATH` deprecate.
3. **store-migrate v2→v3** — `jiraWebhookToken` 누락/형식 불일치 시 `crypto.randomBytes(32).toString('hex')` 로 생성. 64-char hex 형식 검증 포함.
4. **providers/jira/jira-webhook-server.ts 재작성 (255줄)** — path 방식 `/jira-webhook/<token>`, `crypto.timingSafeEqual` 상수 시간 비교, `server.address()` 로 127.0.0.1 바인딩 검증, body 1MB 상한 청크 누적, 5초 타임아웃, `Content-Type: application/json` 필수, `rotateToken()` / `onTokenRotate` 콜백, 로그 마스킹 (URL 에 [REDACTED], body/token 원문 로그 금지).
5. **providers/git/github-reply.ts 신규 (82줄)** — `postReply` 를 github-provider-v3.ts 에서 분리 (300줄 제한). `threadContext === 'review_thread'` 강제 / `issue_comment` quote fallback / 미지정 시 replies API 시도 → 실패 시 quote. quote 포맷: `@author\n> line1\n> line2\n\n<body>`.
6. **ipc-branch.ts 강화 (158줄)** — `buildSlug()` NFKD + ASCII 안전 + 소문자 + `[^a-z0-9]+ → -` + 40자 cut. `isValidBranchName()` [a-zA-Z0-9/_-] + slash≤2 + 영문자 시작 + 255자 + 금지문자 (~^:?*[\\ 공백 // trailing . .lock leading -). `isValidBaseBranch()` 별도 검증. 에러는 'invalid_branch_name' / 'invalid_base_branch' / 'create_failed' 등 토큰화하여 UI 노출. 원문 API body 로그 200자 truncate.
7. **main/project-filter-keys.ts 신규 (85줄)** — `isJiraFilterKey`, `gitFilterKeyFromItem`, `jiraFilterKeyFromIssue`, `jiraFilterKey`, `gitFilterKey`, `isProjectMuted`, `isGitItemMuted`, `isJiraIssueMuted`, `sanitizeProjectFilters`. §20.13.I3 `${jiraConfigId}::jira::${projectKey}` 포맷.
8. **main/poller-events.ts 신규 (142줄)** — `detectPipelineEvents` (seenPipelineIds 중복 제거, 대응 item 은 gitConfigId + sourceBranch 매칭), `detectApprovalEvents` (seenApprovalItemIds), `detectV3ItemEvents` 통합 헬퍼. FIFO cap `MAX_SEEN_PIPELINE_IDS/APPROVAL_ITEM_IDS`.
9. **main/jira-poller.ts 신규 (161줄, §20.13.I2)** — Git poller 와 분리된 자체 `setInterval`. `Promise.allSettled` 로 per-config 실패 격리. `fetchAssignedIssues` + `fetchRecentlyCreated` → `dedupeAndEmit` (seenJiraIssueIds FIFO 200) → `updateRecent` (recentJiraIssues 20). webhook 이벤트도 `ingestWebhookEvent()` 로 동일 중복제거/recent 갱신.
10. **main/main-jira-bridge.ts 신규 (116줄)** — `createJiraBridge(store, {onEvent, onIssues, onError})` 로 폴러 + 웹훅 생명주기 묶음. `setupWebhook()`: `jiraWebhookEnabled && token && primary config` 조건 만족 시에만 기동, 실패는 warn 후 폴링-only 로 fallback (앱 크래시 금지, §20.12.G.1). `reconfigure()` 로 AppSettings 변경에 대응.
11. **poller.ts 확장** — `PollerCallbacks.detectExtraEvents?` optional 훅 추가, tick 4단계(신규/리뷰어/댓글/v3 extra) 흐름 유지. v2 기존 literal(`new_item`/`reviewer_assigned`/`new_comments`) 값 불변 준수 (§20.12.F). 파일 300줄 정확히 유지.
12. **main.ts 배선** — `createJiraBridge` 생성, `start(settings)`, `rebuildJira` → `jiraBridge.reconfigure`, `before-quit` → `jiraBridge.stop`. `reconfigurePoller` 에 `detectExtraEvents: (items, signal) => detectV3ItemEvents(...)` 주입. `onEvent` 에서 `JIRA_ISSUE_NEW` 브로드캐스트, `onIssues` 에서 listWindow `LIST_JIRA_UPDATED` 송출.

### 기타 완료 확인
- `ipc.ts`: COMMENT_REPLY / PROJECT_FILTERS_LOAD/SAVE 핸들러 존재 (v2 본문에 통합). `handleCommentReply` 가 provider.postReply 라우팅 + commented interaction 기록.
- `preload.ts`: v3 채널 전부 expose (loadJiraConnections, saveJiraConnections, testJiraConnection, createBranch, listBranches, postCommentReply, loadProjectFilters, saveProjectFilters, onJiraIssueNew, onListJiraUpdated).
- `types.ts`: `ItemEventKind` 에 v3 5종 literal 직접 union (§20.13.C3), `ItemEventV3`/`ItemEventKindV3` 미사용(삭제). `ItemEvent.kind` 단일.

### 파일 라인수 (300줄 제한 준수)
| 파일 | 라인 |
|---|---|
| poller.ts | 300 |
| poller-events.ts | 142 |
| jira-poller.ts | 161 |
| main-jira-bridge.ts | 116 |
| ipc-branch.ts | 158 |
| ipc-jira.ts | 86 |
| project-filter-keys.ts | 85 |
| providers/jira/jira-provider.ts | 216 |
| providers/jira/jira-webhook-server.ts | 255 |
| providers/git/github-provider-v3.ts | 244 |
| providers/git/gitlab-provider-v3.ts | 218 |
| providers/git/github-reply.ts | 82 |

**main.ts (458줄) / ipc.ts / gitlab-provider.ts / github-provider.ts** 는 v2 본문이며 v3 변경 증분은 최소(각 ~10-30줄). 전체 v2 리팩토링은 scope-creep 로 판단하여 보류 — Orchestrator 판단 요청.

### TypeScript 컴파일
`npx tsc --noEmit` — backend 파일 0 errors. (renderer/review/review.ts 에서 frontend 진행 중인 태스크 #6 관련 에러 4건 있으나 backend 스코프 외)

### 미확인/blocker
- frontend 팀원이 진행 중인 태스크(#3 settings Jira tab, #6 reply UI, #5 list Jira 섹션)와의 결합 검증은 frontend 완료 후 필요.
- `BranchListResult.branches` 가 `string[]` 으로 구현돼 있어 architect §20.1.4 의 `BranchListItem[]` (webUrl/isDefault/protected 포함) 과 다름. 현재 frontend 소비 형태에 맞춰 유지했으나 Reviewer 요구사항에 따라 확장 필요시 후속 작업.

### 결과 파일 목록 (절대경로)
- C:\Users\User\Desktop\Src\pingo\src\shared\types.ts
- C:\Users\User\Desktop\Src\pingo\src\shared\types-v3.ts
- C:\Users\User\Desktop\Src\pingo\src\shared\types-jira.ts
- C:\Users\User\Desktop\Src\pingo\src\shared\constants.ts
- C:\Users\User\Desktop\Src\pingo\src\main\store.ts
- C:\Users\User\Desktop\Src\pingo\src\main\store-migrate.ts
- C:\Users\User\Desktop\Src\pingo\src\main\main.ts
- C:\Users\User\Desktop\Src\pingo\src\main\main-jira-bridge.ts
- C:\Users\User\Desktop\Src\pingo\src\main\poller.ts
- C:\Users\User\Desktop\Src\pingo\src\main\poller-events.ts
- C:\Users\User\Desktop\Src\pingo\src\main\jira-poller.ts
- C:\Users\User\Desktop\Src\pingo\src\main\project-filter-keys.ts
- C:\Users\User\Desktop\Src\pingo\src\main\ipc.ts
- C:\Users\User\Desktop\Src\pingo\src\main\ipc-jira.ts
- C:\Users\User\Desktop\Src\pingo\src\main\ipc-branch.ts
- C:\Users\User\Desktop\Src\pingo\src\main\providers\jira\jira-provider.ts
- C:\Users\User\Desktop\Src\pingo\src\main\providers\jira\jira-webhook-server.ts
- C:\Users\User\Desktop\Src\pingo\src\main\providers\git\git-provider.ts
- C:\Users\User\Desktop\Src\pingo\src\main\providers\git\gitlab-provider-v3.ts
- C:\Users\User\Desktop\Src\pingo\src\main\providers\git\github-provider-v3.ts
- C:\Users\User\Desktop\Src\pingo\src\main\providers\git\github-reply.ts
- C:\Users\User\Desktop\Src\pingo\src\preload.ts
