# 대시보드 동작과 연동

[사용법과 설정](../README.md) · [수신함·질문 파일 형식](inbox-and-asks.md)

## 입력과 개인정보

상태 디렉터리는 `--state-dir DIR`, `AI_TEAM_MONITORING_STATE_DIR`, 기본값 순으로 선택합니다. 기본값은 `XDG_STATE_HOME`이 있으면 `$XDG_STATE_HOME/agent-orchestration`이고, 없으면 `$HOME/.local/state/agent-outer-loop`가 존재할 때 그 경로(심볼릭 링크 포함)를 유지하며, 나머지는 `$HOME/.local/state/agent-orchestration`입니다.

잡 루트는 `--jobs-root DIR`, `AI_TEAM_MONITORING_JOBS_ROOT`, `$HOME/agent-orchestration-jobs` 순으로 선택하며 기존 기본 경로를 유지합니다. 서버는 입력 파일을 모두 읽기 전용으로 열며 레코드, 로그, PID 또는 프로세스 상태를 변경하지 않습니다. 예외로 도구별 사용량의 마지막 조회 캐시 파일 하나만 사용자 캐시 디렉터리에 씁니다.

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
| `$HOME/.claude/projects/**/*.jsonl` | 도구별 사용량: assistant 행의 `timestamp`·`message.id`·`message.usage` 숫자만. 프롬프트·응답·cwd는 버림 |
| `$HOME/.codex/sessions/**/*.jsonl` | 도구별 사용량: `token_count` 이벤트의 누적 토큰과 `rate_limits`(사용률·창 길이·리셋 시각·요금제) |
| `$HOME/.gemini/antigravity/daemon/hub_*.json` | 화면에서 체크 시 살아 있는 언어 서버의 포트와 CSRF 토큰. 토큰은 localhost 요청 헤더에만 사용 |

하트비트와 추가 이벤트는 같은 JSONL 형식을 사용합니다. `AI_TEAM_MONITORING_EVENTS_JSONL`로 추가 파일을 지정할 수 있으며, 기본 `bot-heartbeats.jsonl`도 계속 읽습니다. 각 파일에서 봇별 마지막 유효 행을 사용하고 추가 파일을 나중에 반영합니다. `ts`는 ISO 시각(`Z` 또는 오프셋), `bot`은 필수이며 `phase`는 생략하거나 `start`/`end`를 씁니다. 알 수 없는 필드는 무시하고, 채팅 본문은 기록하지 않습니다.

```sh
printf '%s\n' '{"ts":"2026-11-26T09:29:28+09:00","bot":"Engineering Owner","issue":"ISSUE-123","summary":"짧은 요약","phase":"start"}' >> "$HOME/.local/state/agent-orchestration/bot-heartbeats.jsonl"
```

`agent-outer-loop`가 `agent-orchestration`의 심볼릭 링크인 설치에서는 같은 파일입니다. 경로를 재정의했다면 선택한 상태 디렉터리에 추가하세요.

파일 없음, 잘못된 JSON, 쓰는 중인 JSONL 마지막 행은 허용합니다. JSONL은 개행으로 완료된 행만 처리합니다. 파일별 최근 32 MiB까지만 읽으며 잘린 사용량은 하한값으로 표시합니다. 읽기 실패와 잘린 선택 입력은 화면 하단에 표시합니다. 스냅샷 수집은 겹치지 않습니다. 완료 판정(git merge-base·patch-id 등)은 저장소·통합 대상 SHA·워커 커밋이 같으면 이전 판정을 재사용하고, 종료된 워커의 커밋 제목도 프로세스 수명 동안 재사용해 수집마다 git을 수백 번 실행하지 않습니다. 실행 중인 워커의 제목은 매번 읽습니다. 정상 수집 시 2초마다 SSE로 갱신하고 수집이 2초를 넘으면 완료 후 다음 주기에 갱신합니다.

성공한 워커의 로그·error 원문은 API에 포함하지 않습니다. `failed`·`killed`·`dead` 워커에는 실패 사유와 stderr(없으면 stdout) 마지막 5줄을 마스킹 후 줄당 200자로 잘라 포함합니다. stdout의 JSONL 이벤트는 대화 원문을 담으므로 `type`·`subtype`·`is_error` 같은 허용 필드 요약만 남깁니다. 미등록 프로세스는 바이너리 이름과 하위 명령(`exec`/`-p`)만 표시하며 프롬프트는 수집하지 않습니다. 단계명은 짧은 소문자 키(`[a-z][a-z0-9_-]`, 32자 이하)면 원문 키로, 그 외에는 `unrecognized`로 표시합니다. Post-check는 허용된 판정과 짧은 소문자 식별자 형태의 사유 코드만 표시합니다. 이메일, 자격 증명 형태 문자열, 긴 토큰은 가립니다. 이름 숨기기를 켜면 저장소·Issue·branch·worker ID·taskKey·봇 이름·작업 제목·로그 꼬리·프로세스 cwd를 UI에서 숨깁니다. 체크 상태는 URL 쿼리(`?privacy=1`)에 동기화되어 새로고침해도 유지됩니다. 이 토글은 화면 공유용이며 로컬 API에서 메타데이터를 제거하는 기능은 아닙니다.

서버·페이지는 기본적으로 외부 네트워크 요청을 수행하지 않습니다(예외는 아래 “도구별 사용량”에서 Claude Code 한도와 Cursor를 체크한 경우). 외부 폰트·스크립트·분석 도구·알림이 없고, Host는 정확한 `localhost` 또는 `127.0.0.1`만 허용합니다. 다른 Origin, GET 이외 메서드는 거부합니다. CORS 헤더를 제공하지 않으며 CSP는 `default-src 'self'`를 기본으로 스크립트와 스타일도 자체 파일만 허용합니다. 정적 파일은 고정 경로만 제공합니다.

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

## 도구별 사용량

화면 하단에 고정된(sticky) 한 줄짜리 바가 Claude Code·Codex·Antigravity·Cursor의 사용량을 보여 줍니다. 하네스 워커 로그 기준인 “CLI별 사용량”과 별개이며 대화형 세션도 포함합니다. 각 칸에는 대표 수치와 한도 미니 게이지만 표시하고, 세부 토큰·리셋 시각·요금제는 칸에 마우스를 올리면 나오는 툴팁에 있습니다.

- **조회 켜기**: 모든 도구의 조회는 기본 꺼짐입니다. 바의 체크박스로 켜며 선택은 그 브라우저의 `localStorage`에만 저장합니다. 브라우저는 체크한 도구를 `/api/events?usage=claude,codex`처럼 SSE 쿼리로 보내고, 서버는 열린 SSE 연결이 요청한 도구의 합집합만 조회합니다. 요청하는 연결이 모두 닫히거나 체크를 해제하면 그 도구의 조회를 멈추지만 마지막 데이터는 남겨 두어, 다시 켜거나 페이지를 새로고침해도 로딩 없이 바로 보입니다. 상태 변경용 POST는 없으며 GET 전용 원칙을 유지합니다.
- **갱신 주기와 새로고침**: 체크한 도구를 10분마다 한 번 조회합니다(새로 체크한 도구는 즉시). 바의 ↻ 버튼은 SSE를 `refresh=1`로 다시 열어 켜진 도구를 모두, 상세 패널의 “↻ 다시 조회”는 `refresh=<도구>`로 그 도구만 바로 조회합니다. 원격 API 보호를 위해 강제 조회는 도구마다 30초에 한 번만 받아들이며, 상세 패널에는 그 도구의 마지막 조회 시각을 표시합니다. `refresh`는 `Sec-Fetch-Site`가 없거나 `same-origin`·`none`일 때만 처리해 다른 사이트가 강제 조회를 일으키지 못하게 합니다. 바에는 마지막 조회 시각과 다음 예정 시각을 표시합니다.
- **마지막 조회 캐시**: 조회가 끝날 때마다 도구별 마지막 스냅샷(시간 단위 토큰 집계, 한도 사용률, 크레딧 합계 등 화면에 쓰는 숫자)과 조회 시각을 `~/Library/Caches/ai-team-monitoring/tool-usage.json`(macOS. 그 외 `$XDG_CACHE_HOME` 또는 `~/.cache` 아래, `AI_TEAM_MONITORING_USAGE_CACHE`로 변경 가능)에 0600 권한으로 원자적으로 씁니다. 토큰·자격 증명은 넣지 않습니다. 서버를 재시작하면 이 캐시를 바로 보여 주고, 도구별 마지막 조회 후 10분이 지났을 때 다시 조회합니다. 파일이 없거나 깨졌으면 무시하고 새로 조회합니다. 서버가 쓰는 파일은 이 캐시 하나이며 입력 상태 디렉터리에는 쓰지 않습니다.
- **표시 유지**: 새 조회 결과가 올 때까지 마지막 사용량을 계속 표시합니다. 재조회 중인 도구는 칩 이름 옆에 회전 표시만 붙이고(동작 줄이기 설정에서는 깜빡임) 수치와 조회 시각은 바꾸지 않습니다. 서버는 아직 아무 페이지도 켜지 않은 도구도 데이터가 있으면 그대로 보내고, SSE 연결 직후 첫 메시지에 그 페이지의 사용량을 바로 담습니다. 페이지도 데이터 없는 메시지(서버 재시작 직후 등)를 받으면 직전 값을 유지합니다.
- **수집 방식**: 세션 로그는 파일별 byte offset을 기억해 추가된 행만 읽고, 개행으로 끝난 행만 처리합니다. 최근 7일 안에 수정된 파일만 보며 시간 단위 버킷으로 보관합니다. 2초 SSE는 마지막 스냅샷만 보내므로 조회가 화면 갱신을 막지 않습니다. `collectState`를 직접 호출할 때 수집기를 넘기지 않으면 `toolUsage`는 `null`이고 바를 숨깁니다.
- **집계 기간**: 선택한 기간과 겹치는 시간 버킷을 합산하므로 경계 시간 1개가 포함될 수 있습니다. “전체 기간”은 보관 한도인 최근 7일입니다.
- **Claude Code**: 토큰은 `~/.claude/projects`의 assistant 메시지 `usage`를 `message.id`당 한 번만 셉니다(새 입력 = 입력 + 캐시 쓰기, 캐시 읽기는 별도). 요금제 한도는 Claude Code 로그인(macOS 키체인 `Claude Code-credentials`, 그 외 `~/.claude/.credentials.json`)의 OAuth 토큰으로 `https://api.anthropic.com/api/oauth/usage`를 호출해 5시간·주간(있으면 모델별 주간) 사용률과 리셋 시각을 게이지로 나란히 표시합니다. 이 호출은 모델 추론이 아닌 조회 엔드포인트입니다. 토큰이 만료됐으면 호출하지 않으며, 토큰을 직접 갱신하지 않습니다(갱신하면 Claude Code의 토큰이 바뀌기 때문). Claude Code를 사용하면 Claude Code가 갱신합니다.
- **Codex**: `~/.codex/sessions`의 `token_count` 누적 합계 차이를 이벤트 시각의 시간 버킷에 더합니다(합계가 줄면 새 카운터, 새 입력 = 입력 − 캐시 입력). 가장 최근에 보고된 `rate_limits`의 창별 사용률을 표시하며, 리셋 시각이 지났으면 “보고 이후 리셋됨”으로 표시합니다.
- **Antigravity**: `daemon/hub_*.json`에서 PID가 살아 있는 언어 서버를 골라 `http://127.0.0.1:<httpPort>`의 `GetUserStatus`를 호출합니다. 요금제 이름, 프롬프트·플로 크레딧, 모델별 남은 비율·리셋 시각만 남기고 이름·이메일 등은 버립니다. 가장 적게 남은 모델을 게이지로 표시합니다.
- **Cursor (외부 네트워크)**: `cursor-agent login`이 macOS 키체인 `cursor-access-token`에 저장한 토큰으로 `https://api2.cursor.sh`의 `GetCurrentPeriodUsage`를 호출합니다. Cursor IDE 로그인과는 별개이며, IDE의 암호화된 저장소는 읽지 않습니다. 토큰이 없거나 만료됐으면 호출하지 않고 “cursor-agent login 필요”를 표시합니다. 응답에서는 결제 주기 사용률(`totalPercentUsed`, Auto·API 사용률), 요금제가 보고하는 경우의 금액, 결제 주기 종료 시각, Cursor의 안내 문구(160자 이내)만 남깁니다.

## 레인 커버리지

항상 워커가 하나 이상 실행 중이어야 하는 작업 흐름(레인)을 대시보드 맨 위에 레인별 실행 중 워커 수로 표시합니다. 설정 파일은 `AI_TEAM_MONITORING_LANES` 환경 변수의 경로, 없으면 `$HOME/.local/state/agent-orchestration/lanes.json`이며 서버 시작 시와 매 수집 주기마다 다시 읽습니다. 파일이 없으면 패널을 숨기고 오류로 취급하지 않습니다. 형식이 잘못되면 패널을 숨기고 화면 하단에 “레인 설정 읽기 불가”를 표시합니다.

```json
{"schema":"ai-team-monitoring.lanes/v1","lanes":[{"name":"monitoring","match":{"repo":["ai-team-monitoring"],"issuePrefix":[]}}]}
```

워커의 repo가 `match.repo`에 정확히 있거나 Issue가 `match.issuePrefix` 중 하나로 시작하면 그 레인에 속합니다. 상태가 실행 중이어도 `heartbeatAt`이 60초(하트비트 손실 기준)보다 오래된 워커는 레인의 실행 중 수에 세지 않습니다. 실행 중 워커가 0인 레인은 빨간색으로 표시하고, 0이 된 지 얼마나 됐는지(현재 시각 − 그 레인 워커의 가장 최근 `finishedAt`, 기록이 없으면 “알 수 없음”)를 함께 보여 줍니다. 0인 레인이 하나라도 있으면 파비콘이 빨간색이 되고 문서 제목 앞에 🔴가 붙고 뒤에는 `열린 항목 N건` 요약을 표시합니다. 레인별 상세 항목은 “살펴볼 항목” 패널에서 확인합니다. 이름 숨기기를 켜면 레인 이름을 “레인 01”처럼 표시합니다. 각 레인 카드 아래에는 오늘(Asia/Seoul 자정부터 지금까지) 정상 실행 중 워커 수의 계단형 타임라인이 붙습니다. 워커는 `startedAt`부터 `finishedAt`까지 세되, 마지막 `heartbeatAt`에서 60초(하트비트 손실 기준)가 지나면 상태가 `running`이어도 더 이상 세지 않습니다. 0인 구간은 빨간 기준선으로 표시합니다. 예시는 [레인 설정 예시](../examples/lanes.example.json)을 참고하세요. 실제 레인 이름과 패턴은 저장소에 커밋하지 말고 로컬 설정 파일에만 두세요.

같은 레인 설정으로 “오늘 이력” 카드도 표시합니다. 최근 24시간 집계와 같은 기준(시작 시각이 최근 24시간 안)으로 레인별 성공 수(성공·변경 없음, 읽기 전용 워커의 커밋 없음 포함)와 실패 수(실패·강제 종료·중단 감지)를 세고, 실패는 사후 검사 사유 코드 또는 실패 분류 코드(`dirty-worktree`, `foreign-identity` 등)별로 묶어 보여 줍니다. 알려지지 않은 코드는 그대로 표시하고 자유 형식 사유 문장은 포함하지 않습니다. 어느 레인에도 속하지 않는 워커는 “기타 (레인 없음)” 한 줄로 모읍니다. 데이터는 `/api/state`의 `laneHistory`에 포함되며, 레인 설정 파일이 없으면 `null`이고 카드를 숨깁니다.

## 수신함·열린 질문·다음 단계 대기

이 대시보드는 로컬 우선(local-first)입니다. 클라우드 서비스나 데이터베이스 없이 하네스가 남긴 상태 디렉터리(위 규칙으로 선택한 경로, 이하 `<state>`)의 파일만 읽습니다. 아래 파일이 없으면 해당 패널은 빈 상태로 표시하고 다른 수집은 계속합니다.

- **수신함**: `<state>/inbox/<owner>.jsonl`의 `schema`가 `agent-orchestration.inbox/v1`이고 `workerId`가 있는 행만 읽습니다. 행에 `owner`가 없으면 파일 이름을 담당으로 씁니다. 워커별로 `finishedAt`이 가장 최신인 행을 사용합니다. `<state>/inbox/acks.jsonl`에 `workerId`가 있으면 처리됨으로 보고 `ackedAt`·`by`·`nextWorkerId`만 표시하며 메모나 자유 텍스트는 노출하지 않습니다. 처리되지 않았고 같은 `repo + issue`의 더 새로운 실행이 없는 항목을 미처리로 위에, 처리됨 항목을 아래에 접어 표시합니다.
- **다음 단계 대기**: 수신함 행이 있는 종료된 워커(`succeeded`·`no-changes`·`failed`·`killed`·`dead`) 중 ack가 없고 같은 `repo + issue`의 후속 실행이 없으며 `finishedAt`에서 10분 이상 지난 워커를 실행 중 목록 옆에 표시합니다. 좁은 화면에서는 실행 중 바로 아래에 쌓습니다. Issue 키, 워커 ID, 대기 시간, 다음 단계(`merge` / `verify` / `deploy`), 담당 봇을 표시합니다. 담당 봇은 [로컬 설정](../README.md#담당-매핑-설정)의 접두사 규칙으로 정하며, 수신함의 Release Owner/Verifier는 우선 적용합니다. 다음 단계는 수신함의 `nextStep`을 우선하고, 없으면 Release Owner는 `deploy`, Verifier는 `verify`, 그 외는 `merge`입니다. 담당자 대기는 30분을 초과해야 빨간 알림에 포함합니다. 수신함 행이 없는 성공 워커는 대기에서 제외하지만 미처리 실패·강제 종료는 수신함 유무와 무관하게 빨간 알림에 표시합니다. 레거시 접기 구역은 만들지 않습니다.
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
ISSUE-34 (w-0134) 실패 미처리
ISSUE-33 (w-0133) 다음 단계 대기 31분
승인 대기 ask-1 배포 승인
```

빨간색일 때 문서 제목은 `🔴 (실행 중 워커 수) AI 팀 모니터링 · 열린 항목 N건`, 파비콘 링크의 `title`은 `열린 항목 N건`으로 표시합니다. 헤더의 빨간 배지는 건수를 표시하고, 툴팁은 `열린 항목 N건` 요약과 패널 안내만 보여 줍니다. 배지를 누르면 “살펴볼 항목” 패널로 이동합니다. 이름 숨기기를 켜면 패널의 레인 이름, Issue, 워커 ID, 질문 ID와 제목을 숨기고 “레인 01”, “워커 숨김”, “승인 대기 질문 01”처럼 표시합니다.

## Grok 실행 기록

이 Mac 밖에서 실행되는 Grok 봇 작업도 시작·종료 메타데이터를 이 Mac의 파일에 추가하면 함께 표시됩니다. CLI는 서버를 호출하지 않고 기본 `$HOME/.local/state/agent-orchestration/grok-runs.jsonl`에 한 행씩 추가합니다. 기존 행을 수정하지 않습니다. 경로를 바꾸려면 CLI와 서버 양쪽에 `GROK_RUNS_JSONL`을 설정하세요.

```sh
node tools/grok-run.mjs start --id grok-20261125-001 \
  --bot "Engineering Owner" --task "단계 표시 수정" --issue ISSUE-123
node tools/grok-run.mjs finish --id grok-20261125-001 --status succeeded
# 실패: --status failed / 취소: --status canceled
```

파일 형식은 개행으로 끝나는 JSONL입니다. `start`는 `v`, `id`, `event`, `at`, `bot`, `task`와 선택적 `issue`를, `finish`는 `v`, `id`, `event`, `at`, `status`만 허용합니다.

```jsonl
{"v":1,"id":"grok-20261125-001","event":"start","at":"2026-11-25T04:00:00Z","bot":"Engineering Owner","task":"단계 표시 수정","issue":"ISSUE-123"}
{"v":1,"id":"grok-20261125-001","event":"finish","at":"2026-11-25T04:02:00Z","status":"succeeded"}
```

`v`는 1, 시각은 ISO 문자열(`Z` 또는 시간대 오프셋, 선택적 소수 초 1~3자리)이어야 합니다. ID 128자, 봇 80자, 작업 제목 200자, Issue 64자를 넘거나 빈 문자열·제어 문자·알 수 없는 필드·중복 CLI 옵션이면 거부합니다. 채팅·메시지 본문은 기록하지 마세요. 서버도 동일한 스키마를 검증하고 노출 전에 기존 이메일·자격 증명 필터를 적용합니다.

실행마다 고유 ID를 사용하세요. 서버는 원본 ID별 가장 이른 시작과 그 이후 가장 이른 종료를 합쳐 중복 이벤트를 한 번만 집계합니다. 파일 내 행 순서와 무관하며 시작 없는 종료는 무시합니다. 표시 ID에는 `grok:` 접두사가 붙습니다. 종료가 없으면 6시간까지 `running`, 6시간을 초과하면 `dead`이며 추정 소요 시간은 6시간으로 고정합니다. 종료 이벤트가 도착하면 실제 시작·종료 간격과 최종 상태를 표시합니다. PID를 조회하지 않습니다.

Grok은 `cli`·`agent`가 `grok`인 워커로 목록, 상태 카드, 전체·24시간 집계, Gantt, `byCli`에 포함됩니다. 토큰과 `byCli.grok`은 `null`, 단계 기록은 빈 목록이며 재시도는 미확인입니다. 파일이 없거나 잘못된 행·미완성 마지막 행이 있어도 다른 워커 수집은 계속합니다. 최근 32 MiB 밖의 시작 행은 복원할 수 없습니다.

단계별 간격은 두 끝점으로 해석합니다. 예를 들어 `spec → agent-exit`는 “에이전트 실행”, `preflight → worktree`는 “사전 점검”, `worktree → spec`는 “워크트리 준비”, `agent-exit → post-check`는 “사후 검사”, `post-check → (finish)`는 “마무리”로 표시하고 아래에 작은 원문 키를 남깁니다. 알려진 단계(preflight, worktree, spec, agent-start, agent-exit, post-check, launcher-commit, launcher-tests, failed, dry-run, finished, cleanup)는 한국어로, 그 밖의 키는 원문으로 표시합니다.

## 테스트

```sh
npm test
npm run check
```

화면 코드는 `public/`의 ES 모듈로 나뉩니다. `theme-boot.js`만 첫 화면을 칠하기 전에 테마를 적용하는 일반 스크립트이고, 나머지는 `app.js`에서 시작하는 모듈입니다.

| 파일 | 맡은 일 |
| --- | --- |
| `app.js` | SSE 연결, 각 영역 초기화, 전체 다시 그리기 |
| `store.js` | 최신 스냅숏과 다시 그리기 훅 |
| `lib/dom.js`, `lib/format.js` | DOM·SVG 생성, 숫자·시각 표시 |
| `privacy.js`, `time-window.js`, `theme.js` | 이름 숨기기, 시간 범위, 테마 |
| `worker-text.js` | 워커 상태·단계 이름과 공통 문구 |
| `workers.js`, `feeds.js`, `lanes.js`, `attention.js`, `usage.js` | 워커 표·타임라인, 피드·문의, 레인, 살펴볼 항목·탭 표시, 도구별 사용량 |

모듈끼리 다른 모듈의 변수에 값을 대입하지 않습니다. 공유 상태는 소유한 모듈의 함수(`setState`, `init*`)로만 바꿉니다. 테스트는 `test/helpers/page-source.mjs`가 모듈을 의존 순서대로 이어 붙인 스크립트를 vm에서 실행합니다. 이 방식이 놓치는 import 연결 오류와 import한 이름에 대입하는 코드는 `test/modules.test.mjs`가 실제 모듈 로더로 검사합니다. 서버는 `/`와 `public/` 아래 소문자 이름의 `.js`·`.css`만 제공합니다.

임시 입력 fixture로 JSONL 파싱, CLI별 사용량, liveness, 재시도, 개인정보 필터, 입력 미변경, 24시간 집계, Host·Origin·CSP·정적 경로·SSE를 검증합니다. Grok CLI의 엄격한 검증·추가 쓰기·수집·6시간 경계·중복 이벤트·취소·개인정보 처리와 UI 구간명·Gantt·토큰 미수집 표시도 검증합니다. 실제 입력에 테스트 데이터를 추가하지 않습니다.

## Cursor / Claude CLI / Codex CLI 훅 연동

`tools/cursor-hook.mjs`와 `tools/cli-hook.mjs`는 프롬프트·도구 입출력·대화 원문을 모두 버리고 세션/턴 ID, 모델명, 작업 디렉터리 basename, 시작/종료 시각만 JSONL에 추가합니다. 훅 실패 시에도 항상 fail-open으로 동작합니다.

- **Cursor (`~/.cursor/hooks.json`)**: `beforeSubmitPrompt`, `postToolUse`, `stop`, `sessionEnd`에 `node "$HOME/ai-team-monitoring/tools/cursor-hook.mjs"` 등록 → `cursor-runs.jsonl`
- **Claude Code (`~/.claude/settings.json`)**: `UserPromptSubmit`, `PostToolUse`, `Stop`, `SessionEnd`에 `node "$HOME/ai-team-monitoring/tools/cli-hook.mjs"` 등록 → `cli-runs.jsonl`
- **Codex CLI (`~/.codex/config.toml`)**: `notify = ["node", "<repo>/tools/cli-hook.mjs"]` 등록 → `cli-runs.jsonl`

