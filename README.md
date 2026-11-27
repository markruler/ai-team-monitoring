# Agent Team Monitoring

에이전트 팀의 실행 상태를 확인하는 로컬 라이브 대시보드입니다. Node.js 20 이상과 브라우저가 필요하며 npm 의존성은 없습니다. 서버는 입력 파일을 읽기 전용으로 열고 `127.0.0.1`에 바인딩합니다.

## 설치와 실행

저장소를 내려받은 디렉터리에서 실행합니다.

```sh
npm start          # http://127.0.0.1:4317
npm run dev        # 서버 코드 변경 시 자동 재시작
npm test           # 기존 테스트
npm run check      # 문법 검사
```

`public/` 아래 화면 파일을 저장하면 열린 페이지가 2초 안에 스스로 새로고침합니다. 서버가 화면 파일 내용의 해시를 SSE 메시지의 `assetVersion`에 실어 보내고, 페이지는 처음 받은 값과 달라지면 다시 불러옵니다. `npm start`와 `npm run dev` 모두 같습니다.

브라우저에서 <http://127.0.0.1:4317>을 엽니다. 경로와 포트는 다음처럼 지정합니다.

```sh
node server.mjs --port 4317 \
  --state-dir "$HOME/.local/state/agent-orchestration" \
  --jobs-root "$HOME/agent-orchestration-jobs"
```

macOS에서 launchd 서비스로 실행할 수 있습니다.

```sh
npm run service:install
npm run service:status
npm run service:uninstall
```

`tools/launchd.mjs`는 `com.markruler.ai-team-monitoring` LaunchAgent를 `$HOME/Library/LaunchAgents`에 설치합니다. 서비스는 `node --watch`로 실행되므로 `server.mjs`와 `adapters/` 코드를 고치면 자동으로 재시작합니다. `public/` 파일을 고치면 열린 페이지가 스스로 새로고침합니다. 재시작해도 마지막 사용량 조회 결과는 캐시 파일에서 다시 읽으므로 바로 다시 조회하지 않습니다. `node tools/launchd.mjs print`로 설정을 확인할 수 있습니다.

## 경로와 환경 변수

| 옵션·환경 변수 | 기본값과 우선순위 |
| --- | --- |
| `--port` | `4317` (1~65535) |
| `--state-dir`, `AI_TEAM_MONITORING_STATE_DIR` | CLI 옵션 → 환경 변수 → 아래 기본 상태 경로 |
| `--jobs-root`, `AI_TEAM_MONITORING_JOBS_ROOT` | CLI 옵션 → 환경 변수 → `$HOME/agent-orchestration-jobs` |
| `AI_TEAM_MONITORING_CONFIG` | 담당 매핑 설정 파일 경로. 미지정 시 `<state>/ai-team-monitoring.json` |
| `AI_TEAM_MONITORING_LANES` | `<state>/lanes.json` |
| `AGENT_EVENTS_JSONL` | `<state>/events.jsonl` |
| `GROK_RUNS_JSONL` | `<state>/grok-runs.jsonl` |
| `CURSOR_RUNS_JSONL` | `<state>/cursor-runs.jsonl` |
| `CLI_RUNS_JSONL` | `<state>/cli-runs.jsonl` |
| `AI_TEAM_MONITORING_EVENTS_JSONL` | 추가 봇 이벤트 파일. 기본 `<state>/bot-heartbeats.jsonl`도 계속 읽음 |
| `CLAUDE_PROJECTS_DIR` | 도구별 사용량의 Claude Code 세션 로그. 기본 `$HOME/.claude/projects` |
| `CODEX_SESSIONS_DIR` | 도구별 사용량의 Codex 세션 로그. 기본 `$HOME/.codex/sessions` |
| `ANTIGRAVITY_DIR` | Antigravity 상태 디렉터리. 기본 `$HOME/.gemini/antigravity` |

`<state>`는 선택한 상태 디렉터리입니다. 기본 경로는 `XDG_STATE_HOME`이 있으면 `$XDG_STATE_HOME/agent-orchestration`입니다. 없으면 `$HOME/.local/state/agent-outer-loop`가 존재할 때 그 경로(심볼릭 링크 포함)를 유지하고, 나머지는 `$HOME/.local/state/agent-orchestration`을 사용합니다.

Grok·Cursor·CLI 기록 도구는 기본 `$HOME/.local/state/agent-orchestration`에 append합니다. 상태 경로를 바꿨다면 도구와 서버 양쪽에 해당 JSONL 환경 변수를 설정하세요.

## 담당 매핑 설정

수집마다 `AI_TEAM_MONITORING_CONFIG`가 가리키는 파일을 읽고, 환경 변수가 없으면 `<state>/ai-team-monitoring.json`을 읽습니다. 선택한 파일이 없거나 JSON이 아니면 접두사 규칙 없이 수집을 계속합니다. 저장소 루트의 실설정은 만들지 않으며 `ai-team-monitoring.json`은 gitignore 대상입니다.

```json
{
  "ownerByIssuePrefix": [
    { "prefix": "EXAMPLE", "owner": "Engineering Owner" },
    { "prefix": "TOOLING", "owner": "Tooling Owner" }
  ]
}
```

[중립 설정 예시](examples/ai-team-monitoring.example.json)를 참고하세요. `ownerByIssuePrefix`는 순서가 있는 목록이며, 이슈 키가 `PREFIX-`로 시작하는지 대소문자 구분 없이 비교해 첫 규칙을 적용합니다. 빈 값이나 잘못된 항목은 무시합니다. 수신함의 Release Owner·Verifier 역할은 접두사 규칙보다 우선하고, 일치하는 규칙이 없으면 수신함의 담당을 유지합니다. 담당이 없으면 `unassigned`입니다. `nextStep` 기본값은 Release Owner가 `deploy`, Verifier가 `verify`, 나머지는 `merge`입니다.

## JSONL 이벤트 추가

봇 활동은 한 줄에 JSON 객체 하나인 JSONL에 개행과 함께 append합니다. `ts`는 ISO 시각, `bot`은 필수이며 `phase`는 생략하거나 `start`/`end`를 씁니다. `issue`와 짧은 `summary`는 선택입니다. 채팅·프롬프트·도구 입출력·자격 증명은 기록하지 마세요.

```sh
printf '%s\n' '{"ts":"2026-11-26T09:29:28+09:00","bot":"Engineering Owner","issue":"ISSUE-123","summary":"짧은 요약","phase":"start"}' >> "$HOME/.local/state/agent-orchestration/bot-heartbeats.jsonl"
```

상태 경로를 재정의했다면 선택한 `<state>/bot-heartbeats.jsonl`에 추가하세요. JSONL은 개행으로 완료된 행만 처리합니다.

집계 규칙·레인·알림·파비콘·Grok 및 훅 연동은 [대시보드 동작과 연동](docs/dashboard-behavior.md), 수신함·대기 정책과 파일 형식은 [수신함·질문](docs/inbox-and-asks.md)을 참고하세요.

도구 아이콘: Claude·Cursor는 [Simple Icons](https://simpleicons.org)(CC0), Codex·Antigravity는 [Lobe Icons](https://github.com/lobehub/lobe-icons)(MIT, Copyright (c) LobeHub)의 SVG를 사용합니다. 각 로고는 해당 회사의 상표입니다.

라이선스: MIT · markruler
