# 진정 설계판

소아·성인 시술 진정 약물 조합을 설계하는 웹앱입니다. 시술과 강도(움직임, 통증, 시간, 숨길 공유)를 고르면 약물 조합을 추천하고, 체중 기준 용량, onset·지속·회복, 효과곡선, 상호작용 경고, clinical pearl, 근거 논문을 보여줍니다.

> 교육·케이스 토의용입니다. 용량과 규칙은 원내 진정 프로토콜과 약제부 검토로 확정해서 쓰세요.

## 휴대폰에 설치

- **iPhone**: Safari로 앱 주소 열기 → 공유 버튼 → "홈 화면에 추가"
- **Android**: Chrome으로 열기 → 메뉴(⋮) → "앱 설치" 또는 "홈 화면에 추가"

한 번 열고 나면 인터넷이 없어도 마지막으로 받은 데이터로 작동합니다.

## 수정하는 방법 (GitHub 웹에서)

1. 이 저장소에서 `data` 폴더를 열고 고칠 파일을 누릅니다.
2. 오른쪽 위 연필 아이콘(Edit this file)을 누릅니다.
3. 값을 고친 뒤 **Commit changes** → 한 줄 설명 입력(예: "ketamine IV 용량 원내 기준으로") → 저장.
4. 1–2분 뒤 앱을 새로고침하면 반영됩니다.

**잘못 고쳤을 때**: 앱 맨 위에 빨간 안내가 뜨고 어느 파일의 어느 항목이 문제인지 알려줍니다. 고치거나, 파일 화면의 **History**에서 이전 버전으로 되돌리면 됩니다.

**JSON 작성 규칙 세 가지**: 글자는 큰따옴표 `"..."`로 감쌉니다. 항목 사이에는 쉼표를 넣고, 마지막 항목 뒤에는 쉼표를 넣지 않습니다. 숫자는 따옴표 없이 씁니다.

## 파일별 설명

| 파일 | 내용 |
|---|---|
| `data/drugs.json` | 약물, 성격 점수, 경로별 용량·시간, 효과·부작용 |
| `data/procedures.json` | 시술 preset |
| `data/flags.json` | 위험인자 버튼 |
| `data/scoring.json` | 추천 점수를 올리거나 깎는 규칙 |
| `data/interactions.json` | 상호작용·경고 문구 |
| `data/pearls.json` | 상황별 clinical pearl |
| `data/evidence.json` | 근거 논문 카드 |
| `index.html`, `styles.css`, `app.js`, `sw.js` | 화면과 계산 엔진. 보통 수정할 필요 없음 |

### drugs.json

```json
{
  "id": "ketamine",          // 영문 고유 이름. 다른 파일에서 이 id로 부릅니다
  "ko": "케타민", "en": "Ketamine",
  "kind": "sed",             // sed = 진정제, opi = 진통제(opioid)
  "resp": false,             // 호흡억제 약이면 true
  "adjunct": false,          // true면 왼쪽 목록의 "더하는 약"에 표시
  "pedOnly": false,          // true면 소아 탭에서만 표시
  "props": { "depth": 2, "analg": 4, "airway": 3.5, "recov": 2 },  // 0–4점: 깊이 조절, 진통, 숨 보존, 짧은 회복
  "good": ["..."], "bad": ["..."],
  "routes": {
    "ped":   { "IV": { ... }, "IM": { ... } },
    "adult": { "IV": { ... } }
  }
}
```

경로 하나(`"IV": {...}`)의 구성:

| 항목 | 의미 |
|---|---|
| `lab` | 화면에 보이는 경로 이름 (IV, 코, 경구 등) |
| `onset` | 효과가 충분해지기까지 분 |
| `dur` | 1회 투여 후 효과 지속 분 |
| `rec` | 효과가 끝난 뒤 회복까지 분 |
| `os` | 빠른 시작 점수 0–4 |
| `inf` | 지속주입이 가능한 경로면 `true` (시간 제한 없음으로 계산) |
| `dose` | 용량 목록. `{ "t": "초기", "r": [1, 2], "u": "mg/kg", "cap": 50 }` |

용량 단위 `u`는 `mg/kg`, `mcg/kg`, `mcg/kg/min`, `mcg/kg/h` 중 하나입니다. `cap`은 1회 최대량(mg 또는 mcg), 나이별 최대량은 `"capByAge": [{ "below": 1, "cap": 1000 }, { "cap": 2000 }]`처럼 씁니다. `"note": "..."`를 넣으면 용량 아래에 메모가 표시됩니다.

새 약물을 추가하면 색은 기본 강조색으로 표시됩니다.

### procedures.json

```json
{ "id": "shunt", "n": "Shunt tap", "m": 2, "p": 2, "T": 15, "a": 0, "tags": [] }
```
`m` 움직임 0–3, `p` 통증 0–3, `T` 분, `a` 숨길 공유 0/1. `tags`에 `"img"`(영상), `"eeg"`, `"neuro"`를 넣으면 해당 규칙과 pearl이 연결됩니다.

### 규칙 파일의 `when` 조건 (scoring, interactions, pearls 공통)

모든 조건을 동시에 만족할 때만 작동합니다.

| 조건 | 예시 | 의미 |
|---|---|---|
| `mode` | `"ped"` | 소아 또는 성인 탭 |
| `drugsAll` | `["dex", "ketamine"]` | 이 약이 모두 선택됨 |
| `drugsAny` | `["midazolam", "fentanyl"]` | 하나라도 선택됨 |
| `lacksDrugs` | `["propofol"]` | 이 약이 선택되지 않음 |
| `flags` | `["icp"]` | 위험인자가 켜짐 |
| `procAny` | `["img", "lp"]` | 시술 id 또는 tag |
| `routes` | `{ "dex": "IN" }` | 특정 경로로 선택됨 |
| `ageBelow` / `ageAtLeast` | `0.25` / `65` | 나이(세) 미만 / 이상 |
| `minDrugs` | `3` | 선택 약물 수 이상 |
| `sedCountAtLeast` | `2` | 진정제 수 이상 |
| `respCountAtLeast` | `1` | 호흡억제 약 수 이상 |
| `minM`, `minP`, `minT`, `maxT` | `2` | 움직임·통증 단계, 시간 범위 |
| `sharedAirway` | `true` | 숨길 공유 여부 |
| `airwayBelow` | `3` | 조합의 숨 보존 점수가 이보다 낮음 |
| `anyOf` | `[ {조건}, {조건} ]` | 안의 조건 중 하나라도 맞음 |

- **scoring.json**: `"type"`은 `con`(감점 사유), `pro`(장점), `hard`(추천에서 제외). `"delta"`는 점수 변화.
- **interactions.json**: `"level"`은 `hard`, `high`, `mid`, `info`. `"tag"`는 배지 글자.
- **pearls.json**: `"text"`만 있으면 됩니다.

### evidence.json

```json
{ "id": "green2009", "status": "approved", "mode": ["ped"], "tags": ["ketamine"],
  "yr": 2009, "design": "개별환자 메타분석", "type": "meta", "n": "8,282",
  "au": "Green SM, et al.", "src": "Ann Emerg Med 2009;54(2):158–168",
  "pmid": "", "title": "...", "key": "핵심 결과 한두 문장" }
```

- `status`: `approved`는 정식 카드, `pending`은 "검토 대기"로 위에 따로 표시
- `type`: `rct`, `meta`, `gl`(가이드라인), `reg`(코호트·레지스트리) — 배지 색
- `tags`: 약물 id, 위험인자 id, 시술 tag, `guide`(항상 표시), `multi`(2제 이상 선택 시), `neuro`(3세 미만)
- `pmid`를 넣으면 PubMed 원문으로 바로 연결되고, 비우면 제목으로 검색합니다
- 수정한 날에는 `lastReviewed` 날짜도 바꿔 주세요

## 추천 점수 민감도

`app.js` 맨 위의 `WEIGHTS`가 부족한 축마다 깎는 점수입니다. 추천 순위가 실제 진료와 다르게 느껴지면 이 값을 조정하거나 저에게 요청하세요.
