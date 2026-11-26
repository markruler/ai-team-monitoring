# Agent Team Monitoring

에이전트 팀의 실행 상태를 확인하는 로컬 라이브 대시보드입니다. 모든 코드를 직접 작성했으며 다른 저장소의 코드를 가져오거나 사용하지 않습니다. Node.js 20 이상과 브라우저만 필요하고 npm 의존성은 없습니다.

## 실행

```sh
cd "$HOME/ai-team-monitoring"
npm start          # http://127.0.0.1:4317 실행
npm run dev        # 파일 변경 시 자동 재시작 (node --watch)
npm test           # 테스트 실행
npm run check      # 문법 검사
```

브라우저에서 <http://127.0.0.1:4317>을 엽니다. 서버는 항상 `127.0.0.1`에만 바인딩합니다. 잘못된 옵션이나 포트는 거부합니다.

백그라운드 실행:

```sh
mkdir -p "$HOME/agent-orchestration-jobs/ai-team-monitoring"
nohup node "$HOME/ai-team-monitoring/server.mjs" --port 4317 \
  > "$HOME/agent-orchestration-jobs/ai-team-monitoring/server.log" 2>&1 < /dev/null &
echo "PID: $!"
```

## 입력과 개인정보

기본 입력 디렉터리는 `$HOME/.local/state/agent-orchestration`입니다. 서버는 모든 파일을 읽기 전용으로 열며 레코드, 로그, PID 또는 프로세스 상태를 변경하지 않습니다.

| 입력 | 사용 범위 |
| --- | --- |
| `local-workers/*/record.json` | 실행 식별 정보, 상태, 시각, 단계, PID, 구조화된 post-check 코드 |
| `local-workers/*/stdout.log` | Claude 마지막 `result`의 `usage`·`total_cost_usd`·`num_turns`(누적값), Codex `turn.completed.usage`의 숫자. 실패 워커는 마지막 줄 요약 |
| `local-workers/*/stderr.log` | 실패·강제 종료·중단 워커의 마지막 줄과 사유 패턴 |
| `record.specFile` | 첫 Markdown 제목(작업 이름). `local-workers` 안의 경로만 읽음 |
| `ps`, `lsof` (macOS) | 레코드에 없는 codex/claude/agy/cursor-agent `exec`/`-p` 및 대화형 `codex`/`claude` CLI 프로세스의 PID, 경과 시간, cwd (데몬·보조 명령 제외) |
| `events.jsonl` | 허용된 이벤트 메타데이터와 숫자. `AGENT_EVENTS_JSONL` 환경 변수로 경로 지정 가능 |
| `grok-runs.jsonl` | Grok 시작·종료 메타데이터. `GROK_RUNS_JSONL` 환경 변수로 경로 지정 가능 |
| `bot-heartbeats.jsonl` | 봇이 턴 시작·종료에 append하는 `bot`, `issue`, `summary`(짧은 요약, 채팅 본문 금지), `ts`(ISO 시각), `phase`(`start` 또는 `end`, 선택). 봇별 마지막 유효 행을 활동에 반영하며 최근 30분 이내 종료도 현재 작업에 표시 |
| `cursor-runs.jsonl` | Cursor 훅(`tools/cursor-hook.mjs`)이 기록한 턴 시작·하트비트·종료 메타데이터(모델·워크스페이스 basename만). `CURSOR_RUNS_JSONL` 환경 변수로 경로 지정 가능 |
| `cli-runs.jsonl` | Claude Code / Codex CLI 훅(`tools/cli-hook.mjs`)이 기록한 턴 시작·하트비트·종료 메타데이터(모델·작업 디렉터리 basename만). `CLI_RUNS_JSONL` 환경 변수로 경로 지정 가능 |
| `alerts.jsonl` | 파싱 가능한 행 개수만, 외부 알림 없음 |
| `handoffs.jsonl` | 인계 시각, CLI, 종류, taskKey, 대기 초 |
| `lanes.json` | 레인 이름과 repo·Issue 접두사 패턴. `AI_TEAM_MONITORING_LANES` 환경 변수로 경로 지정 가능 |
| `inbox/<owner>.jsonl`, `inbox/acks.jsonl` | 종료 워커 수신함 항목과 처리(ack) 기록. 아래 “수신함·열린 질문·다음 단계 대기” 참고 |
| `asks.jsonl` | 열린 질문의 ID, 제목, 담당, 생성 시각, 연결된 워커 ID |

파일 없음, 잘못된 JSON, 쓰는 중인 JSONL 마지막 행은 허용합니다. JSONL은 개행으로 완료된 행만 처리합니다. 파일별 최근 32 MiB까지만 읽으며 잘린 사용량은 하한값으로 표시합니다. 읽기 실패와 잘린 선택 입력은 화면 하단에 표시합니다. 스냅샷 수집은 겹치지 않습니다. 정상 수집 시 2초마다 SSE로 갱신하고 수집이 2초를 넘으면 완료 후 다음 주기에 갱신합니다.

성공한 워커의 로그·error 원문은 API에 포함하지 않습니다. `failed`·`killed`·`dead` 워커에는 실패 사유와 stderr(없으면 stdout) 마지막 5줄을 마스킹 후 줄당 200자로 잘라 포함합니다. stdout의 JSONL 이벤트는 대화 원문을 담으므로 `type`·`subtype`·`is_error` 같은 허용 필드 요약만 남깁니다. 미등록 프로세스는 바이너리 이름과 하위 명령(`exec`/`-p`)만 표시하며 프롬프트는 수집하지 않습니다. 단계명은 짧은 소문자 키(`[a-z][a-z0-9_-]`, 32자 이하)면 원문 키로, 그 외에는 `unrecognized`로 표시합니다. Post-check는 허용된 판정과 짧은 소문자 식별자 형태의 사유 코드만 표시합니다. 이메일, 자격 증명 형태 문자열, 긴 토큰은 가립니다. 이름 숨기기를 켜면 저장소·Issue·branch·worker ID·taskKey·봇 이름·작업 제목·로그 꼬리·프로세스 cwd를 UI에서 숨깁니다. 체크 상태는 URL 쿼리(`?privacy=1`)에 동기화되어 새로고침해도 유지됩니다. 이 토글은 화면 공유용이며 로컬 API에서 메타데이터를 제거하는 기능은 아닙니다.

서버·페이지는 외부 네트워크 요청을 수행하지 않습니다. 외부 폰트·스크립트·분석 도구·알림이 없고, Host는 정확한 `localhost` 또는 `127.0.0.1`만 허용합니다. 다른 Origin, GET 이외 메서드는 거부합니다. CORS 헤더를 제공하지 않으며 CSP는 `default-src 'self'`를 기본으로 스크립트와 스타일도 자체 파일만 허용합니다. 정적 파일은 고정 경로만 제공합니다.

## 집계 규칙

- **상태 정규화**: 워커의 원본(raw) 상태 `completed-no-changes`는 기존 `no-changes`(변경 없음) 버킷으로 정규화해 집계하며 `unknown`으로 세지 않습니다. 알 수 없는 raw 상태만 `unknown`(미확인)으로 남습니다.
- **Liveness**: `starting/running`에서 양의 정수 PID가 있으면 하나라도 `process.kill(pid, 0)`으로 살아 있을 때 실행 중입니다. 모두 사라지면 `dead`입니다. EPERM은 존재하는 프로세스로 취급합니다. PID가 없으면 시작·heartbeat·lastLog·updatedAt·단계 시각 중 최신이 15분을 초과했을 때 `dead`입니다. 표시만 바꾸며 입력에는 쓰지 않습니다. PID 재사용은 구분하지 못합니다.
- **집계 기간**: 1시간·3시간(기본)·6시간·12시간·24시간·전체 기간 프리셋 또는 직접 입력한 N시간(양의 정수) 안에 시작한 실행을 집계합니다. 선택은 URL 쿼리(`?window=3h`, `?window=all`, `?window=5h`)와 `localStorage`에 저장하며, 둘 다 있으면 URL이 우선합니다. 잘못된 값은 무시하고 마지막 유효 기간을 유지합니다. 실행 중(`running`·`starting`)이거나 다음 단계 대기 중인 워커는 기간과 무관하게 항상 표시하고 상태 카드에도 포함합니다. 서버 `summary.day`/`summary.all`은 24시간·전체 기준으로 계속 제공합니다. 실패율 = `(failed + killed + dead) / (succeeded + no-changes + failed + killed + dead + canceled)`. 취소는 완료 분모에 포함하며 실패로 세지 않습니다.
- **재시도**: 동일 `repo + issue + branch`의 두 번째 이후 실행입니다. 시간순으로 전체 기록에서 판별한 후 기간을 적용합니다. `branchName`도 허용합니다. 식별 정보가 없는 실행은 미확인으로 표시하고 재시도율 분모에서 제외합니다. 재시도율 = `재실행 수 / 식별 가능한 실행 수`입니다. 삭제된 과거 기록은 복원할 수 없습니다.
- **시간**: 단계별 시간은 해당 단계 시각부터 다음 단계 시각까지의 간격입니다. 실제 작업과 대기를 분리할 근거가 없으므로 합친 간격으로 표시합니다. 마지막 단계는 종료 또는 현재까지이며, 종료 시각이 없으면 끝점을 워커 상태(예: 실패, 중단 감지)로 표시합니다. 종료 시각 없는 중단·완료 레코드는 마지막 관측 시각까지 추정합니다. 인계 파일이 있으면 명시적인 `waitSec`도 표시합니다.
- **비용 / 토큰**: 열의 대표값과 정렬 값(`data-sort-value`)은 CLI가 보고한 `total_cost_usd`입니다. 가격표로 추정하지 않습니다. 새 입력(Claude: 입력 + 캐시 쓰기, Codex: 입력 − 캐시 입력)·캐시 읽기·출력·턴 수는 보조 값으로 따로 표시하며, 캐시 읽기를 포함한 합계는 표시하지 않습니다. Claude `result`는 누적값이므로 마지막 행만 사용하고, Codex `turn.completed`는 turn마다 더합니다. 보고되지 않은 값(비용이 없는 Codex, 사용량이 없는 로그 등)은 0이 아니라 `—`입니다. 이벤트의 토큰은 워커 로그와 중복될 수 있어 총 사용량에 더하지 않습니다. Grok은 사용량을 수집하지 않아 목록·상세·CLI별 집계에서 `—`로 표시합니다.
- **실패 사유**: `postCheck.reasons` → `reason`·`failureReason`·`error`·`spawnError` 등 기록 필드 → `signal`/`killedBy`/`killReason` → 단계(`preflight` 직후 `failed`면 “사전 점검 거부”) → 로그 패턴(agent-task-rejected, 이슈 키 누락, EPERM/EACCES, no-commits, SIGTERM/SIGKILL, timeout, ENOENT, usage) → 상태(`dead`는 process-dead) 순으로 정합니다. 기록된 사유와 단계 근거가 함께 있으면 “사전 점검 거부: …”처럼 함께 표시합니다. `lost-heartbeat`, `repeat-failure-blocked`, `killed` 등 알려진 키는 한국어로, 모르는 키는 원문으로 표시합니다. 근거가 없으면 “사유 기록 없음 (이전 런처 기록)”입니다.
- **미등록 프로세스**: macOS에서 `ps -axo pid,ppid,etime,command`로 codex/claude/agy의 `exec`/`-p` 실행을 찾고, 레코드의 `agentPid`·`launcherPid`·`pid`와 그 하위 프로세스를 제외합니다. 래퍼와 네이티브 자식은 바깥 프로세스 하나로 셉니다. cwd는 `lsof -a -d cwd -p PID -Fn`으로 읽어 홈을 `~`로 줄입니다. `ps` 실패 시 표시하지 않습니다. 별도 카드로 세며 실행 집계에는 넣지 않습니다.
- **이벤트**: 최근 100개 메타데이터를 유지하고 화면에는 기간에 맞는 최근 6개를 표시합니다. 워커 상태의 기준은 `record.json`이며 이벤트만으로 중복 실행을 만들지 않습니다.

## 레인 커버리지

항상 워커가 하나 이상 실행 중이어야 하는 작업 흐름(레인)을 대시보드 맨 위에 레인별 실행 중 워커 수로 표시합니다. 설정 파일은 `AI_TEAM_MONITORING_LANES` 환경 변수의 경로, 없으면 `$HOME/.local/state/agent-orchestration/lanes.json`이며 서버 시작 시와 매 수집 주기마다 다시 읽습니다. 파일이 없으면 패널을 숨기고 오류로 취급하지 않습니다. 형식이 잘못되면 패널을 숨기고 화면 하단에 “레인 설정 읽기 불가”를 표시합니다.

```json
{"schema":"ai-team-monitoring.lanes/v1","lanes":[{"name":"monitoring","match":{"repo":["ai-team-monitoring"],"issuePrefix":[]}}]}
```

워커의 repo가 `match.repo`에 정확히 있거나 Issue가 `match.issuePrefix` 중 하나로 시작하면 그 레인에 속합니다. 상태가 실행 중이어도 `heartbeatAt`이 60초(하트비트 손실 기준)보다 오래된 워커는 레인의 실행 중 수에 세지 않습니다. 실행 중 워커가 0인 레인은 빨간색으로 표시하고, 0이 된 지 얼마나 됐는지(현재 시각 − 그 레인 워커의 가장 최근 `finishedAt`, 기록이 없으면 “알 수 없음”)를 함께 보여 줍니다. 0인 레인이 하나라도 있으면 파비콘이 빨간색이 되고 문서 제목 앞에 🔴가 붙고 뒤에는 `열린 항목 N건` 요약을 표시합니다. 레인별 상세 항목은 “살펴볼 항목” 패널에서 확인합니다. 이름 숨기기를 켜면 레인 이름을 “레인 01”처럼 표시합니다. 각 레인 카드 아래에는 오늘(Asia/Seoul 자정부터 지금까지) 정상 실행 중 워커 수의 계단형 타임라인이 붙습니다. 워커는 `startedAt`부터 `finishedAt`까지 세되, 마지막 `heartbeatAt`에서 60초(하트비트 손실 기준)가 지나면 상태가 `running`이어도 더 이상 세지 않습니다. 0인 구간은 빨간 기준선으로 표시합니다. 예시는 `examples/lanes.example.json`을 참고하세요. 실제 레인 이름과 패턴은 저장소에 커밋하지 말고 로컬 설정 파일에만 두세요.

같은 레인 설정으로 “오늘 이력” 카드도 표시합니다. 최근 24시간 집계와 같은 기준(시작 시각이 최근 24시간 안)으로 레인별 성공 수(성공·변경 없음, 읽기 전용 워커의 커밋 없음 포함)와 실패 수(실패·강제 종료·중단 감지)를 세고, 실패는 사후 검사 사유 코드 또는 실패 분류 코드(`dirty-worktree`, `foreign-identity` 등)별로 묶어 보여 줍니다. 알려지지 않은 코드는 그대로 표시하고 자유 형식 사유 문장은 포함하지 않습니다. 어느 레인에도 속하지 않는 워커는 “기타 (레인 없음)” 한 줄로 모읍니다. 데이터는 `/api/state`의 `laneHistory`에 포함되며, 레인 설정 파일이 없으면 `null`이고 카드를 숨깁니다.

## 수신함·열린 질문·다음 단계 대기

이 대시보드는 로컬 우선(local-first)입니다. 클라우드 서비스나 데이터베이스 없이 하네스가 남긴 상태 디렉터리(기본 `$HOME/.local/state/agent-orchestration`, 이하 `<state>`)의 파일만 읽습니다. 기본 경로는 하네스의 상태 디렉터리 상수를 따르므로 하네스에서 이름이 바뀌면 함께 맞춰야 합니다. 아래 파일이 없으면 해당 패널은 빈 상태로 표시하고 다른 수집은 계속합니다.

- **수신함**: `<state>/inbox/<owner>.jsonl`의 `schema`가 `agent-orchestration.inbox/v1`이고 `workerId`가 있는 행만 읽습니다. 행에 `owner`가 없으면 파일 이름을 담당으로 씁니다. 워커별로 `finishedAt`이 가장 최신인 행을 사용합니다. `<state>/inbox/acks.jsonl`에 `workerId`가 있으면 처리됨으로 보고 `ackedAt`·`by`·`nextWorkerId`만 표시하며 메모나 자유 텍스트는 노출하지 않습니다. 처리되지 않았고 같은 `repo + issue`의 더 새로운 실행이 없는 항목을 미처리로 위에, 처리됨 항목을 아래에 접어 표시합니다.
- **다음 단계 대기**: 수신함 행이 있는 종료된 워커(`succeeded`·`no-changes`·`failed`·`killed`·`dead`) 중 ack가 없고 같은 `repo + issue`의 후속 실행이 없으며 `finishedAt`에서 10분 이상 지난 워커를 실행 중 목록 옆에 표시합니다. 좁은 화면에서는 실행 중 바로 아래에 쌓습니다. Issue 키, 워커 ID, 대기 시간, 다음 단계(`merge` / `verify` / `deploy`), 담당 봇을 표시합니다. HARNESS·AIMON·SECRET·AWSDEV는 Tooling Owner, AUTOISSUE는 Engineering Owner가 기본 담당이며, 수신함의 Release Owner/Verifier는 우선 적용합니다. 다음 단계는 수신함의 `nextStep`을 우선하고, 없으면 Release Owner는 `deploy`, Verifier는 `verify`, 그 외는 `merge`입니다. 담당자 대기는 30분을 초과해야 빨간 알림에 포함합니다. 수신함 행이 없는 성공 워커는 대기에서 제외하지만 미처리 실패·강제 종료는 수신함 유무와 무관하게 빨간 알림에 표시합니다. 레거시 접기 구역은 만들지 않습니다.
- **열린 질문**: `<state>/asks.jsonl`에서 `schema`가 `agent-orchestration.asks/v1`이고 `status`가 `open`인 질문만 최근 50개까지 표시합니다. `workerIds` 중 현재 실행 중인 워커가 없으면 빨간색으로 표시합니다.
- **읽기 전용 워커**: 레코드나 수신함 행이 `mode: read-only`이면 `읽기 전용` 라벨을 붙입니다. 커밋을 만들지 않는 것이 정상이므로 `no-changes` 결과나 사유가 `no-commits`인 실패는 성공으로 집계합니다.

이름 숨기기를 켜면 수신함의 워커·저장소·Issue·담당·처리자와 열린 질문의 제목·담당도 화면에서 숨깁니다.

## 탭 아이콘(파비콘) 색

파비콘은 지금 사용자가 봐야 할 열린 항목이 있을 때만 빨간색입니다. 열린 항목은 다음과 같습니다.

- **실행 0 레인**: 하트비트가 살아 있는(60초 이내) 실행 중 워커가 없는 레인.
- **미처리 실패**: `failed`·`killed`로 끝났지만 재시도·후속 실행도 ack도 없는 워커. 기간 제한은 없습니다.
- **다음 단계 대기**: 위의 다음 단계 대기 조건을 만족하고 30분을 초과해 미인계 상태인 워커.
- **승인 대기**: 열린 질문 목록(`asks`)에 남아 있는 열린 질문·승인 요청.

ack됐거나 같은 `repo + issue`의 더 새로운 실행(재시도·후속 단계)이 있는 워커(`resolved: true`)는 실패 사유에서 빠지고, 다음 단계 대기에서도 빠집니다. Grok 실행은 repo가 없으므로 실행 ID로 ack됐거나 같은 Issue의 더 새로운 Grok 실행이 있으면 해소된 것으로 봅니다. 미등록 실행 중 프로세스는 빨간색 사유가 아닙니다. 열린 항목이 없으면 실행 중 워커가 있을 때 파란색, 없으면 초록색입니다.

“살펴볼 항목” 패널은 열린 항목을 한 줄에 하나씩 보여 줍니다. 각 줄은 레인 이름, `Issue (워커 ID)` 또는 질문 ID로 어느 항목인지 알 수 있습니다. 예:

```text
레인 review 실행 0
AIMON-34 (w-0134) 실패 미처리
AIMON-33 (w-0133) 다음 단계 대기 31분
승인 대기 ask-1 배포 승인
```

빨간색일 때 문서 제목은 `🔴 (실행 중 워커 수) AI 팀 모니터링 · 열린 항목 N건`, 파비콘 링크의 `title`은 `열린 항목 N건`으로 표시합니다. 헤더의 빨간 배지는 건수를 표시하고, 툴팁은 `열린 항목 N건` 요약과 패널 안내만 보여 줍니다. 배지를 누르면 “살펴볼 항목” 패널로 이동합니다. 이름 숨기기를 켜면 패널의 레인 이름, Issue, 워커 ID, 질문 ID와 제목을 숨기고 “레인 01”, “워커 숨김”, “승인 대기 질문 01”처럼 표시합니다.

## Grok 실행 기록

이 Mac 밖에서 실행되는 Grok 봇 작업도 시작·종료 메타데이터를 이 Mac의 파일에 추가하면 함께 표시됩니다. CLI는 서버를 호출하지 않고 기본 `$HOME/.local/state/agent-orchestration/grok-runs.jsonl`에 한 행씩 추가합니다. 기존 행을 수정하지 않습니다. 경로를 바꾸려면 CLI와 서버 양쪽에 `GROK_RUNS_JSONL`을 설정하세요.

```sh
node tools/grok-run.mjs start --id grok-20261125-001 \
  --bot "Engineering Owner" --task "단계 표시 수정" --issue AUTOISSUE-123
node tools/grok-run.mjs finish --id grok-20261125-001 --status succeeded
# 실패: --status failed / 취소: --status canceled
```

파일 형식은 개행으로 끝나는 JSONL입니다. `start`는 `v`, `id`, `event`, `at`, `bot`, `task`와 선택적 `issue`를, `finish`는 `v`, `id`, `event`, `at`, `status`만 허용합니다.

```jsonl
{"v":1,"id":"grok-20261125-001","event":"start","at":"2026-11-25T04:00:00Z","bot":"Engineering Owner","task":"단계 표시 수정","issue":"AUTOISSUE-123"}
{"v":1,"id":"grok-20261125-001","event":"finish","at":"2026-11-25T04:02:00Z","status":"succeeded"}
```

`v`는 1, 시각은 ISO 문자열(`Z` 또는 시간대 오프셋, 선택적 소수 초 1~3자리)이어야 합니다. ID 128자, 봇 80자, 작업 제목 200자, Issue 64자를 넘거나 빈 문자열·제어 문자·알 수 없는 필드·중복 CLI 옵션이면 거부합니다. 채팅·메시지 본문은 기록하지 마세요. 서버도 동일한 스키마를 검증하고 노출 전에 기존 이메일·자격 증명 필터를 적용합니다.

실행마다 고유 ID를 사용하세요. 서버는 원본 ID별 가장 이른 시작과 그 이후 가장 이른 종료를 합쳐 중복 이벤트를 한 번만 집계합니다. 파일 내 행 순서와 무관하며 시작 없는 종료는 무시합니다. 표시 ID에는 `grok:` 접두사가 붙습니다. 종료가 없으면 6시간까지 `running`, 6시간을 초과하면 `dead`이며 추정 소요 시간은 6시간으로 고정합니다. 종료 이벤트가 도착하면 실제 시작·종료 간격과 최종 상태를 표시합니다. PID를 조회하지 않습니다.

Grok은 `cli`·`agent`가 `grok`인 워커로 목록, 상태 카드, 전체·24시간 집계, Gantt, `byCli`에 포함됩니다. 토큰과 `byCli.grok`은 `null`, 단계 기록은 빈 목록이며 재시도는 미확인입니다. 파일이 없거나 잘못된 행·미완성 마지막 행이 있어도 다른 워커 수집은 계속합니다. 최근 32 MiB 밖의 시작 행은 복원할 수 없습니다.

단계별 간격은 두 끝점으로 해석합니다. 예를 들어 `spec → agent-exit`는 “에이전트 실행”, `preflight → worktree`는 “사전 점검”, `worktree → spec`는 “워크트리 준비”, `agent-exit → post-check`는 “사후 검사”, `post-check → (finish)`는 “마무리”로 표시하고 아래에 작은 원문 키를 남깁니다. 알려진 단계(preflight, worktree, spec, agent-start, agent-exit, post-check, launcher-commit, launcher-tests, failed, dry-run, finished, cleanup)는 한국어로, 그 밖의 키는 원문으로 표시합니다.

## 테스트

```sh
node --test
node --check server.mjs
node --check public/app.js
node --check tools/grok-run.mjs
```

임시 입력 fixture로 JSONL 파싱, CLI별 사용량, liveness, 재시도, 개인정보 필터, 입력 미변경, 24시간 집계, Host·Origin·CSP·정적 경로·SSE를 검증합니다. Grok CLI의 엄격한 검증·추가 쓰기·수집·6시간 경계·중복 이벤트·취소·개인정보 처리와 UI 구간명·Gantt·토큰 미수집 표시도 검증합니다. 실제 입력에 테스트 데이터를 추가하지 않습니다.

## Cursor / Claude CLI / Codex CLI 훅 연동

`tools/cursor-hook.mjs`와 `tools/cli-hook.mjs`는 프롬프트·도구 입출력·대화 원문을 모두 버리고 세션/턴 ID, 모델명, 작업 디렉터리 basename, 시작/종료 시각만 JSONL에 추가합니다. 훅 실패 시에도 항상 fail-open으로 동작합니다.

- **Cursor (`~/.cursor/hooks.json`)**: `beforeSubmitPrompt`, `postToolUse`, `stop`, `sessionEnd`에 `node "$HOME/ai-team-monitoring/tools/cursor-hook.mjs"` 등록 → `cursor-runs.jsonl`
- **Claude Code (`~/.claude/settings.json`)**: `UserPromptSubmit`, `PostToolUse`, `Stop`, `SessionEnd`에 `node "$HOME/ai-team-monitoring/tools/cli-hook.mjs"` 등록 → `cli-runs.jsonl`
- **Codex CLI (`~/.codex/config.toml`)**: `notify = ["node", "<repo>/tools/cli-hook.mjs"]` 등록 → `cli-runs.jsonl`

## launchd 상시 실행 (macOS)

```sh
npm run service:install
npm run service:status
npm run service:uninstall
```

`tools/launchd.mjs`는 `com.markruler.ai-team-monitoring` LaunchAgent(`RunAtLoad`, `KeepAlive`)를 `~/Library/LaunchAgents`에 설치·로드합니다. 템플릿만 필요하면 `tools/com.markruler.ai-team-monitoring.plist` 또는 `node tools/launchd.mjs print`를 사용하세요.

라이선스: MIT · markruler
