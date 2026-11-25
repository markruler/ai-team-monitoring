# 수신함(inbox)·질문(asks) 파일 형식

대시보드가 읽는 수신함, ack, 열린 질문 파일의 형식입니다. 모두 한 줄에 JSON 객체 하나인 JSONL이며, 대시보드는 읽기만 합니다. 기준 구현은 `server.mjs`의 `readInbox`, `inboxByWorker`, `ackedWorkers`, `awaitingFlags`, `inboxView`, `openAsks`입니다.

## 상태 디렉터리

아래 `<state>`는 하네스의 상태 디렉터리입니다. 현재 값은 `"$HOME/.local/state/agent-outer-loop"`이고, 대시보드는 `collectState({ base })`의 기본값으로 이 경로를 씁니다. 파일을 쓰는 쪽은 경로를 하드코딩하지 말고 하네스의 기존 상태 디렉터리 상수나 환경 변수로 결정해야 합니다. 이후 디렉터리 이름이 바뀔 수 있습니다.

```text
<state>/
├── inbox/
│   ├── <owner>.jsonl
│   └── acks.jsonl
└── asks.jsonl
```

## 수신함: `<state>/inbox/<owner>.jsonl`

워커 하나가 끝날 때마다 한 줄을 추가합니다.

```json
{"schema":"agent-orchestration.inbox/v1","workerId":"w-123","repo":"example-repo","issue":"EX-1","owner":"unassigned","status":"succeeded","reason":"","finishedAt":"2026-01-01T00:00:00.000Z","branch":"ex-1-branch","mode":"read-only"}
```

| 필드 | 설명 |
| --- | --- |
| `schema` | `agent-orchestration.inbox/v1`이어야 합니다. 다르면 무시합니다. |
| `workerId` | 비어 있지 않은 문자열이어야 합니다. 없으면 무시합니다. |
| `repo`, `issue` | 같은 작업의 새 시도인지 판단하는 키입니다. `issue`는 문자열이나 숫자를 받습니다. |
| `owner` | `worker start --owner <bot>` 또는 환경 변수 `AGENT_TASK_OWNER`에서 가져옵니다. 기본값은 `unassigned`입니다. 행에 없으면 파일 이름의 `<owner>`를 씁니다. |
| `status` | 워커 종료 상태입니다(`succeeded`, `failed`, `killed` 등). |
| `reason` | 종료 사유입니다. 대시보드는 분류된 라벨만 표시합니다. |
| `finishedAt` | ISO 8601 종료 시각입니다. |
| `nextStep` | 선택 필드입니다. `merge`, `verify`, `deploy`만 받습니다. 없으면 Release Owner는 `deploy`, Verifier는 `verify`, 그 외는 `merge`입니다. |
| `branch` | 하네스가 기록합니다. 현재 대시보드는 읽지 않습니다. |
| `mode` | 현재 구분하는 값은 `read-only`뿐입니다. read-only 워커의 no-changes 결과는 성공으로 봅니다. |

같은 `workerId`가 여러 번 나오면 `finishedAt`이 가장 늦은 행을 씁니다.

## ack: `<state>/inbox/acks.jsonl`

수신함 항목을 처리했다고 표시합니다.

```json
{"workerId":"w-123","ackedAt":"2026-01-01T00:20:00.000Z","by":"unassigned","note":"","nextWorkerId":"w-124"}
```

| 필드 | 설명 |
| --- | --- |
| `workerId` | ack 대상 워커입니다. 필수입니다. |
| `ackedAt` | ISO 8601 시각입니다. 같은 워커에 ack가 여러 개면 가장 늦은 것을 씁니다. |
| `by` | ack한 주체입니다. |
| `note` | 자유 메모입니다. 대시보드는 노출하지 않습니다. |
| `nextWorkerId` | 선택 필드입니다. 다음 단계 워커가 이어받은 경우에 적습니다. |

## 다음 단계 대기 규칙

워커가 아래 조건을 모두 만족하면 "다음 단계 대기"로 표시합니다.

1. 수신함 행이 있고 워커가 끝났습니다(`succeeded`, `failed`, `killed`; 코드에서는 `no-changes`, `dead`도 종료로 봅니다).
2. `acks.jsonl`에 해당 `workerId`가 없습니다.
3. 같은 `repo`+`issue`에 더 새로운 워커가 없습니다.
4. `finishedAt`으로부터 10분 이상 지났습니다.

수신함 패널의 "미처리" 목록은 1~3만 적용하고, 4까지 만족하는 항목에 대기 표시를 붙입니다.

실행 중 목록 옆(좁은 화면에서는 바로 아래)에 Issue 키·워커 ID·대기 시간·다음 단계·담당 봇을 표시합니다. 담당 봇은 HARNESS·AIMON·SECRET·AWSDEV는 Tooling Owner, AUTOISSUE는 Engineering Owner이며, 수신함의 Release Owner/Verifier가 우선입니다. 담당자 대기는 30분 초과 시에만 빨간 알림으로 승격합니다. 미처리 `failed`·`killed`는 대기 시간과 수신함 유무에 관계없이 빨간 알림에 표시하며, ack 또는 후속 실행이 있으면 제외합니다.

## 열린 질문: `<state>/asks.jsonl`

```json
{"schema":"agent-orchestration.asks/v1","id":"ask-1","title":"배포 승인 필요","owner":"unassigned","status":"open","createdAt":"2026-01-01T00:00:00.000Z","workerIds":["w-123"]}
```

| 필드 | 설명 |
| --- | --- |
| `schema` | `agent-orchestration.asks/v1`이어야 합니다. |
| `id`, `title` | 질문 식별자와 제목입니다. |
| `owner` | 없으면 `unassigned`로 표시합니다. |
| `status` | `open` 또는 `done`입니다. `open`만 표시합니다. |
| `createdAt` | ISO 8601 생성 시각입니다. |
| `workerIds` | 관련 워커 ID 배열입니다. 이 중 실행 중인 워커가 없으면 담당 없음으로 강조합니다. |

## 파일이 없거나 깨진 경우

- 파일이나 `inbox/` 디렉터리가 없으면 해당 패널을 빈 상태로 표시하고 오류를 내지 않습니다.
- 잘못된 JSON 줄, 객체가 아닌 줄, 쓰다 만 마지막 줄은 건너뜁니다.
- 큰 파일은 끝부분만 읽습니다.
