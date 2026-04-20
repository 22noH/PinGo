# Orchestrator — v3 확장 브리핑

STATUS: DONE
PHASE: 4-COMPLETE
CURRENT_ACTION: Phase 4 PASS — v3 구현 완료
LAST_UPDATED: 2026-04-20

---

## 프로젝트 현황 (v2 완료 상태)

pingo는 GitLab/GitHub MR/PR 감지 -> Windows 트레이 토스트 알림 -> AI 리뷰 기능이 완전히 구현된 상태다.

### 현재 구현된 주요 파일
src/main/: main.ts, tray.ts, poller.ts, notifier.ts, ipc.ts, ipc-review.ts,
           review-runner.ts, store.ts, store-migrate.ts, windows.ts, preseed.ts
           providers/git/: git-provider.ts, gitlab-provider.ts, github-provider.ts
           providers/ai/: ai-provider.ts, claude-cli.ts, codex-cli.ts,
                          anthropic-api.ts, openai-api.ts, ollama.ts
src/renderer/: review/, settings/, list/
src/shared/: types.ts, constants.ts
src/preload.ts

### 현재 타입 핵심 (수정 금지, 확장만)
- GitProviderType = 'gitlab' | 'github'
- GitConfig = GitLabConfig | GitHubConfig
- ItemEventKind = 'new_item' | 'reviewer_assigned' | 'new_comments'
- AppSettings.gitConnections: GitConfig[]
- StoreSchema v2: settings, seenItemIds, seenReviewerItemIds, lastSeenNoteAt, interactions, recentItems

스토어 현재 버전: v2 (store-migrate.ts에 v1->v2 마이그레이션 존재)

---

## v3 확장 범위 (확정)

### A — GitLab/GitHub 추가 이벤트
ItemEventKind 확장:
- pipeline_finished  : CI/CD 파이프라인 성공/실패
- mr_approved        : MR/PR 승인됨
- changes_requested  : 변경 요청됨
- issue_assigned     : GitLab/GitHub 이슈 나에게 할당
- issue_mentioned    : 이슈/PR 코멘트에서 @멘션

### B — Jira 연동
- Cloud: email + API Token (Basic Auth base64)
- Server/DC: Personal Access Token (Bearer)
- 폴링 30초 기본 + 웹훅 수신기 선택 (로컬 HTTP, 포트 기본 9876)
이벤트: jira_issue_assigned, jira_issue_created
브랜치 생성: feature/PROJ-123-title-slug, git 연결 선택, 베이스 브랜치 선택

### C — 기존 기능 개선
- 댓글 답글(Reply): 기존 토론 스레드에 인라인 답글
- 프로젝트별 알림 필터: 특정 프로젝트 뮤트 ON/OFF

---

## Architect 설계 요청 항목

1. 새 타입 (types.ts 확장)
   - JiraConfig (type:'jira', authType:'cloud'|'server', url, email?, apiToken, watchedProjectKeys)
   - JiraIssueSummary (id: "jiraConfigId::PROJ-123", issueKey, summary, status, priority, assignee?, reporter, webUrl, projectKey, createdAt, updatedAt)
   - JiraEventKind = 'jira_issue_assigned' | 'jira_issue_created'
   - JiraEvent { kind, issue: JiraIssueSummary }
   - ItemEventKind 확장 (기존 3개 + pipeline_finished, mr_approved, changes_requested, issue_assigned, issue_mentioned)
   - PipelineInfo { id, status:'success'|'failed'|'canceled', webUrl, ref, finishedAt }
   - ItemEvent에 pipelineInfo?: PipelineInfo 추가
   - GitIssue { id, issueId, title, webUrl, projectId, assignees, mentionedAt? }
   - BranchCreatePayload { gitConfigId, jiraIssueKey, branchName, baseBranch, projectId, repoFullName? }
   - BranchCreateResult { success, branchName?, webUrl?, error? }
   - BranchListPayload/Result
   - CommentReplyPayload extends CommentPostPayload + { discussionId }
   - ProjectFilter { projectId: string, muted: boolean }
   - ApprovalStatus { approved, approvedBy: ReviewItemAuthor[], changesRequested }

2. AppSettings v3 추가 필드
   jiraConnections, jiraWebhookEnabled(false), jiraWebhookPort(9876),
   projectFilters, pipelineNotificationsEnabled(true), approvalNotificationsEnabled(true)

3. StoreSchema v3 추가 필드
   seenJiraIssueIds, recentJiraIssues(max20), seenPipelineIds, seenApprovalItemIds

4. 새 IPC 채널 (constants.ts)
   Main->Renderer: JIRA_ISSUE_NEW='jira:issue:new', LIST_JIRA_UPDATED='list:jira:updated'
   Renderer->Main(handle): JIRA_CONNECTIONS_LOAD, JIRA_CONNECTIONS_SAVE, JIRA_CONNECTION_TEST,
                            BRANCH_CREATE, BRANCH_LIST, COMMENT_REPLY, PROJECT_FILTERS_SAVE

5. 새 파일 목록
   src/main/providers/jira/jira-provider.ts (~250줄)
   src/main/providers/jira/jira-webhook-server.ts (~150줄)
   src/main/ipc-jira.ts (~200줄)
   src/main/ipc-branch.ts (~120줄)
   src/renderer/settings/settings-jira.ts (~200줄)
   src/renderer/list/branch-modal.ts (~150줄)

6. GitProvider 인터페이스 v3 확장 (optional 메서드)
   fetchRecentPipelines?, fetchApprovalStatus?, fetchAssignedIssues?,
   fetchMentionedIssues?, createBranch?, listBranches?, postReply?

7. Jira Webhook 동작
   POST /jira-webhook, webhookEvent 파싱, 담당자 매칭, seenJiraIssueIds 중복 제거
   설정창에 URL 표시 + 복사 버튼

8. 브랜치명 규칙: feature/{KEY}-{slug}, slug 소문자+하이픈, 최대 40자

9. v2->v3 마이그레이션 기본값 (전부 안전한 빈 배열/기본값으로)

---

## Phase 계획
Phase 1: Architect 설계 (architect.md STATUS:DONE)
Phase 2: Backend 구현 (shared + providers + ipc + store)
Phase 3: Frontend 구현 (settings-jira, branch-modal, list 확장)
Phase 4: Reviewer 통합 검증

## 전 팀원 공통 금지사항
- 기존 v2 타입/채널 직접 수정 금지 (확장만)
- any 타입 금지, console.log 금지, 파일 300줄 초과 금지, 하드코딩 금지
