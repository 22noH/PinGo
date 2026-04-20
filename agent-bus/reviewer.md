# reviewer

STATUS: DONE (사전 리뷰 Phase 1)
PHASE: v3 사전 리뷰 — Architect REVISION 10 §20.12 + §20.13 team-lead 정정 검증 완료
LAST_UPDATED: 2026-04-20
RESULT: **PASS** (§20.13 정정 전부 수용, 타입·IPC 계약 잠금, Backend 구현 착수 승인)

## §20.13 team-lead 정정 검증 요약
전 항목 보안/구조 타당성 기준 개선으로 판단. 특히:
- I1: UUID 122bit → randomBytes(32) hex 256bit 엔트로피↑ + StoreSchema 최상위로 이동 → 마스킹 정규식 #4 갱신 필요
- I3: Jira key 중간 segment 고정(`::jira::`) → Git key 와 `split('::')[1]` 판별 자리 대칭 (우수)
- I4: slug 40 + 전체 255 분리 → Git 엔진 한도 정확 반영
- I5: review thread 네이티브 + issue comment quote fallback → UX 개선
- C3: ItemEventKindV3 alias 제거 → exhaustive switch 타입 에러 자동 노출 (원 권고 일치)

## Phase 4 통합 검증 체크리스트 (§20.12.I + §20.13 업데이트)
§20.12.I 9개 + 추가 8개 — 아래 "다음 단계" 섹션 상단에 기록.

---

## 사전 리뷰 결과

### RESULT: CONDITIONAL PASS
설계 전체 품질 양호. 아래 Critical 3건은 REVISION 10 에서 반영 필수.
Important 5건은 Backend 구현 진입 전 Architect/Backend 합의 필요.
Minor 6건은 Backend 구현 중 참고.

---

## 🔴 Critical (REVISION 10 반영 필수)

### C1. Webhook URL 방식 — query token → path token 으로 변경 권장
§20.4.2 / §20.6 / §20.10(A) 에서 `?token=<32B hex>` 쿼리 방식으로 확정되어 있으나,
선제 자문(Reviewer)에서 path 방식 권장 근거가 누락됨.
- query string 은 리버스 프록시/웹서버 access.log 에 기본 기록되고, referer 헤더 경유 전파 가능.
- 로컬 전용이라도 token 노출 표면 최소화가 원칙.
- **권장 변경**: `http://127.0.0.1:9876/jira-webhook/<32B hex>` path 형태 + `crypto.timingSafeEqual`.
- 그대로 query 방식 유지 시 근거를 §20.10 에 명시 요.

### C2. Webhook body size 과대
§20.4.2 / §20.8.3 공히 "JSON body 상한 **2MB**". 선제 자문에서 **1MB 권장**.
- Jira issue payload 평균 수 KB. 2MB 는 메모리 고갈 표면 확대.
- 1MB 로 낮추거나 2MB 근거 명시 필요.

### C3. ItemEventKindV3 새 alias 는 타입 파손 위험
§20.1.2 가 `ItemEventKindV3` 라는 **별도 type** 을 신설.
- 기존 v2 코드의 `ItemEventKind` 참조는 3종만 본다 → v3 이벤트 송출 시 타입 불일치/누락.
- **권장**: `ItemEventKind` 자체 union 을 직접 확장(기존 3개 literal 보존 + 5개 append).
  별도 `V3` alias 신설 금지. orchestrator.md 브리핑의 "기존 3개 + 신규 5개 추가" 규약과 일치.

---

## 🟡 Important (Backend 진입 전 확정)

### I1. Webhook token persist 위치 미명세
§20.4.2 `controller.token` 은 노출되나 저장 위치 불명.
- 제안: `StoreSchemaV3Additions.jiraWebhookToken: string`. 첫 기동 시 `crypto.randomUUID()` 기반 32B hex 생성, 재생성 버튼으로 rotate.
- 저장 안 하면 앱 재시작 시마다 Atlassian 재등록 필요(UX 파손).

### I2. Jira 폴링 격리 보장 미기재
§20.4.5: "Jira poller 는 ... 동일 tick piggy-back."
- 동일 tick 공유 시 Jira 실패가 Git 폴링 chain 을 차단하지 않도록 `Promise.allSettled` 명시 필요.
- 현 v2 `poller.ts:44-52` 패턴 재사용 기재로 충분.

### I3. projectFilter Jira 측 키공간 부재
§20.1.6 `ProjectFilter.projectKey` 는 Git 측 3-part 규약만 명세.
- jira_issue_* 이벤트에도 뮤트 적용되는지 불명. 제안: `${jiraConfigId}::jira::${projectKey}` 3-part 로 키공간 공유(provider 자리에 'jira' literal). orchestrator.md §C "프로젝트별 알림 필터" 요구와 정합.

### I4. BRANCH_NAME_MAX_LEN 의미 모호
§20.2 상수 40 / §20.7 "최대 길이 40. feature/KEY-{slug} 총 ≤ 60자"
- 40 이 slug 만인지 branch 이름 전체인지 상수 이름만으로 불명. 제안: 상수를 `BRANCH_SLUG_MAX_LEN` 으로 개명하거나 주석에 "슬러그 부분만" 명시.

### I5. GitHub Reply API 한계 명세 필요
§20.4.3: `POST /repos/:owner/:repo/pulls/:number/comments/:comment_id/replies` 는 review 스레드 한정.
- 일반 issue/PR 대화 댓글은 threading 미지원 → `discussionId` 가 review comment 아니면 Backend 가 400 반환해야 함.
- Frontend 도 reply 가능 댓글 유형 구분 표시 필요(2차 리뷰 검증 항목).

---

## 🟢 Minor (Backend 구현 중 참고)

### M1. §20.1.2 ItemEvent 확장 코드 누락
주석만 있고 실제 인터페이스 after-picture 없음. Backend 측이 직접 수정해야 하므로 확정된 코드 블록 제공 권장.

### M2. §20.1.3 providerLabel 하드코딩
`'GL' | 'GH'` 주석. `PROVIDER_SHORT_LABEL[providerType]` 참조 권장(v2 비블로킹 관찰 #2 재지적).

### M3. §20.1.9 JiraWebhookEvent — status/priority 방어
`fields.status.name`, `fields.priority.name` 은 커스텀 워크플로우에서 다른 구조 가능. Backend 파싱 시 optional chaining + default 문자열 필수.

### M4. §20.5 schemaVersion 저장 위치 불명
"`schemaVersion: 3` 기록" 만 언급. electron-store 루트 키 명시 권장.

### M5. §20.7 슬러그 금칙 목록 불완전
§20.7 에 `.lock`, `..`, leading `-` 만 명시. `^`, `~`, `:`, `?`, `*`, `[`, `\`, 공백 은 "사전 치환" 가정이나 blacklist 재검증 단계 명시 권장.

### M6. §20.11 Reviewer 인수 조건 — tsc 전수 명시
`npx tsc -p tsconfig.json --noEmit` exit=0 명시적 추가 권장(v2 phase 5 기준 유지).

---

## ✅ 설계 긍정 평가
- §20.9 types.ts 분할 결정 — 300줄 제약 선제 대응.
- §20.3 `ElectronAPIV3` 인터페이스 분리 — v2 선언 불변.
- §20.2 v3 채널 전부 신설 + `AnyMainToRendererChannel` 합집합 — 하위호환.
- §20.8 보안 7개 항목 — 마스킹 확장, encodeURIComponent, CSP 유지 적절.
- §20.4.2 `crypto.timingSafeEqual` — 선제 자문 반영.
- §20.10 자문 수용 내역 투명 기록.

---

## 판정
**초판 CONDITIONAL PASS → REVISION 10 검증 후 PASS** (사전 리뷰 종결)

## REVISION 10 (§20.12) 검증 결과 — 2026-04-20
- ✅ C1 (§20.12.A): query→path `/jira-webhook/{secret}` + `timingSafeEqual` + `server.address()` 바인딩 검증 + body 1MB
- ✅ C2 (§20.12.A): body size 1MB 로 하향 확정
- ✅ C3 (§20.12.F): `ItemEventKind` literal 보존 엄수 + backend 진입 전 `grep` 검증 요구 명시
- ✅ I1 (§20.12.A/H): `jiraWebhookSecret` AppSettings 필드 + rotateSecret() 메서드
- ✅ I2 (§20.12.G.2): `Promise.allSettled` 격리 + `JiraConnectionHealth` 신규
- ✅ I3 (§20.12.E): Git 3-part + Jira `jira::` prefix 3-part 완전 분리 + `isJiraFilterKey()` 헬퍼
- ✅ I4 (§20.12.C): 슬러그 40 + 전체 120 한도 명확화
- ✅ I5 (§20.12.C): API error body UI 비노출 + errorCode enum 번역
- ✅ M1~M6: §20.12.C~H 에 대부분 반영 (providerLabel 하드코딩 M2 는 backend 구현 시 검증 대상)

## 추가 평가
- §20.12.H 타입·상수 델타 요약 → Backend 즉시 착수 지원용 우수
- §20.12.I 9개 체크리스트 → Phase 4 통합 검증에 그대로 사용 가능
- §20.12.D 마스킹 정규식 5개 완전 명시 (UUID webhook secret 도 마스킹 포함)
- §20.12.C sanitize 규칙 + errorCode 번역 테이블 완비

## Phase 4 통합 검증 체크리스트 (Architect 잠금 기준 + §20.12.I + §20.13 — 최종)

### 계약 불변성 (Architect 잠금 4파일)
- [ ] `src/shared/types.ts` / `types-jira.ts` / `types-v3.ts` / `constants.ts` 에 architect 미경유 변경 0건
- [ ] deprecated 상수 (`JIRA_WEBHOOK_PATH`, `BRANCH_NAME_MAX_LEN`) 신규 참조 0건 → path prefix / SLUG_LEN 사용
- [ ] ItemEventKind (v2 3종 + v3 5종) + JiraEventKind (2종) 전부 exhaustive handle
- [ ] IPC 호출 리터럴 문자열 0건 — `constants.ts` export 상수 경유만

### Jira webhook 보안
- [ ] 토큰 `randomBytes(32).toString('hex')` 64-char hex, 사용자 입력 경로 없음
- [ ] `timingSafeEqual` 사용 (`===`/`==` 금지)
- [ ] body 1MB 초과 400 + 소켓 5s 타임아웃
- [ ] path 기반 URL `/jira-webhook/{token}` (쿼리스트링 잔재 0건)
- [ ] `server.address()` 로 127.0.0.1 바인딩 검증
- [ ] wrong token POST → 401/404 (타이밍 동일)
- [ ] Content-Type !== application/json → 400
- [ ] token 로테이션 후 구 URL → 401
- [ ] 로그 샘플 `Basic [...]`/`Bearer [...]`/`glpat-*`/`ghp_*`/webhook token(hex64) 0건

### 브랜치 생성
- [ ] slug ≤ 40 (`BRANCH_NAME_MAX_SLUG_LEN`)
- [ ] 전체 branchName ≤ 255 (`BRANCH_NAME_MAX_TOTAL_LEN`)
- [ ] slug 소문자 + 하이픈, `feature/{KEY}-{slug}` 포맷
- [ ] 베이스 브랜치 선택 필수 (UI + ipc-branch 재검증)
- [ ] branchName 주입 차단 (`..`, `~`, `^`, 공백, leading `-` 등)
- [ ] baseBranch 임의 IPC 위변조 차단

### Store 마이그레이션
- [ ] v2 저장소 무손실 로드 + 기본값 backfill
- [ ] v3 optional 필드 누락 시 런타임 crash 없음
- [ ] seenJiraIssueIds / seenPipelineIds / seenApprovalItemIds 중복제거 + FIFO max 200
- [ ] recentJiraIssues max 20
- [ ] `StoreSchema.jiraWebhookToken` 첫 기동 시 64-char hex 생성
- [ ] `AppSettings.jiraWebhookSecret` 필드 0건 (§20.12.A 철회)

### GitHub Reply fallback (§20.13.I5)
- [ ] review thread → 네이티브 reply API
- [ ] issue comment → quote 형태 새 comment
- [ ] 원문 첫 3줄 cut 동작
- [ ] quote 내 `@user` notification 재발화 방지 (escape/backtick)

### ItemEventKind (§20.13.C3)
- [ ] v2 literal 3종(`new_item`, `reviewer_assigned`, `new_comments`) 문자열 보존
- [ ] `ItemEventKindV3` alias 잔재 0건
- [ ] `ItemEvent.kind: ItemEventKind` 단일 참조

### ProjectFilter 키 (§20.13.I3)
- [ ] Git key `${gitConfigId}::${providerType}::${projectId}`
- [ ] Jira key `${jiraConfigId}::jira::${projectKey}` (중간 segment 고정)
- [ ] `isJiraFilterKey()` = `split('::')[1] === 'jira'` 동작

### 코드 규약
- [ ] `any` 0건, `console.*` 0건, 파일 300줄 초과 0건
- [ ] electron-log 전용 사용
- [ ] `npx tsc -p tsconfig.json --noEmit` exit=0
- [ ] §20.12.D 마스킹 정규식 #4 `[0-9a-fA-F]{64}` 갱신 적용

## 다음 단계
- ✅ Architect 에게 Critical/Important 전달 완료
- ✅ Backend 에게 사전 브리핑 완료
- ✅ Team-lead 보고 완료
- ✅ §20.12 REVISION 10 검증 + PASS 통보
- ✅ §20.13 team-lead 정정 검증 + 전 항목 ACK
- ⏳ Backend DONE 시 1차 리뷰 착수 예정
- ⏳ Frontend DONE 시 2차 리뷰 + 상기 17개 Phase 4 체크리스트 전수 검증 예정

---

## 과거 결과 (참고 보존)
- Phase 1 (v1): PASS
- Phase 2 (v2 1차): CONDITIONAL PASS
- Phase 3 (v2 재리뷰): PASS
- Phase 4 (SDK 교체 포함): PASS
- Phase 5 (task #22, 1차 backend 최종 리뷰): PASS
