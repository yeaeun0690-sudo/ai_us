# AI 마음 탐사대 프론트엔드

계명대학교 디지털상담 연구실의 청소년 생성형 AI 사용 종단 연구용 정적 웹 프론트엔드입니다. 빌드 도구 없이 HTML, CSS, inline JavaScript로 동작하며 CloudType 정적 컨테이너로 배포합니다.

## 파일 구조

- `index.html`: 참여 신청, 참여자·연구자 로그인, 설문 진행, 대화문 제출 및 제출 내역
- `researcher.html`: 신청 승인, 참여 현황, 미완료자, 파일 삭제, 결과 다운로드, 어뷰징 검토, 활성·유입 분석
- 루트 이미지 파일: 대상별 랜딩·설문·대화문 안내 자산

프론트와 API는 별도 저장소입니다. 백엔드 구현과 정확한 HTTP 계약은 `ai_us_backend/README.md`와 `ai_us_backend/docs/api-contract.md`를 기준으로 확인합니다.

## 실행 구조

- 외부 프레임워크나 번들러를 사용하지 않습니다.
- 인증 정보는 `sessionStorage`의 `ai_us_access_token`, `ai_us_role`, `ai_us_username`에 저장합니다.
- 설문 임시 답변과 완료 marker는 `localStorage`를 사용하지만, 서버의 제출 완료 상태가 최종 기준입니다.
- `AI_US_API_BASE`는 frontend hostname으로 개발·운영 backend를 선택합니다. 알 수 없는 hostname은 운영 backend를 사용하므로 로컬 테스트에서는 API를 mock하거나 개발 backend URL을 명시적으로 검토해야 합니다.
- 네트워크 오류와 5xx는 공통 full-modal로 안내하고, 401/403은 세션을 정리한 뒤 로그인 화면으로 이동합니다.

## 확정된 참여자 흐름

1. 신청 또는 CSV 등록으로 참여자 계정을 생성합니다.
2. 참여자는 휴대폰 번호와 대상(`elementary` 또는 `secondary`)으로 로그인합니다.
3. 최초 비밀번호 `1234`를 변경해야 설문과 대화문 화면에 접근할 수 있습니다.
4. 설문은 `SURVEY_SETS`의 `surveyRound`, `surveyVersion`, `audience`, `part`를 사용합니다.
5. 최종 제출 후 Queue 상태가 `completed`가 되어야 임시 답변을 삭제하고 완료 처리합니다.
6. 완료된 회차는 참여자가 수정하거나 재제출할 수 없습니다.
7. 파트 1 완료 후 파트 2를 열고, 파트 2 완료 후 대화문 제출 동의가 있으면 대화문 탭으로 이동합니다.
8. 대화문은 링크·본문·ZIP·이미지로 제출할 수 있습니다. 공유 링크는 원문으로 저장하지만 crawler나 AI로 자동 수집하지 않습니다. ZIP은 1개, 이미지는 최대 20개이며 파일당 25MB, 요청 전체 100MB 제한입니다. Gemini 파싱은 이미지 한 장이 20MB 이상이면 실패합니다.
9. 개인정보처리방침은 페이지 하단의 접고 펼치는 영역에서 확인할 수 있습니다.

## 확정된 연구자 흐름

`researcher.html`은 기본적으로 `관리하기` 영역을 열며, `일괄 등록하기`에서 참여자 CSV를 등록합니다. `admin`과 `researcher`가 대부분의 조회·승인·다운로드 기능을 공유하고, 자동 승인 설정 변경과 연구자 계정 생성은 `admin`만 수행합니다.

### 대화문 결과 관리

- 미리보기는 기본적으로 `review_filter=unreviewed`를 사용합니다.
- 관리 상태는 `미검토`, `사례금 지급 완료`, `사례 대상 제외`, `중복 제출`, `기타 사유`입니다.
- 저장 값은 각각 없음, `incentive_paid`, `excluded`, `duplicate`, `other`입니다.
- 모든 상태는 `저장` 버튼으로 확정합니다. `미검토` 저장은 review 삭제 요청입니다.
- 메모는 모든 검토 상태에서 선택 입력할 수 있고 `기타 사유`에서만 필수입니다.
- 기타 사유 메모 누락은 native `alert()`가 아니라 확인 버튼이 있는 full-modal로 표시합니다.
- 관리 상태 저장부터 목록 재조회 완료까지 확인 버튼 없는 full-modal과 spinner를 유지하고 자동으로 닫습니다.
- 행 체크박스는 다운로드 대상 선택용이며 관리 상태와 별개입니다. 명시적으로 선택한 ID는 현재 회차·학교급 조건 안에서 관리 상태 필터만 우회하고, `현재 조건 전체 선택`은 현재 필터 전체를 작업 payload에 전달합니다.

### 대화문 파싱과 다운로드

- 연구자는 원본 첨부 ZIP, 개별 파싱 결과 JSON/CSV, 선택 대화문 CSV ZIP을 내려받을 수 있습니다.
- 파싱 요청은 비동기 Queue 작업이며 상태를 polling합니다.
- 이미지 제출은 backend의 Gemini screenshot parser가 화자와 대화 순서를 추출합니다.
- ZIP은 지원되는 서비스별 export adapter로 처리하고, 지원하지 않는 형식은 warning과 `parse-failures.csv`로 남깁니다.
- 대량 원본·대화문 다운로드는 비동기 job이므로 완료 URL이 생긴 뒤 파일을 받습니다.

## 변경 원칙

- `SURVEY_SETS`는 설문 화면의 원본입니다. 확정된 key와 option value를 임의로 바꾸지 않습니다.
- 운영 중인 설문의 key 구조가 바뀌면 기존 버전을 덮어쓰지 않고 새 `surveyVersion`을 사용합니다.
- MongoDB URI, JWT secret, Gemini API key, 연구자 비밀번호를 프론트에 넣지 않습니다.
- 기존 inline script와 디자인 체계를 유지하고, 요청과 무관한 구조 변경이나 라이브러리 추가를 피합니다.
- API 성공 전 완료 UI로 이동하지 않으며 backend의 `detail` 메시지를 우선 사용합니다.

## 로컬 확인

정적 서버 예시:

```bash
python -m http.server 4187
```

브라우저에서 `http://localhost:4187/index.html` 또는 `researcher.html`을 엽니다. 로컬 hostname은 운영 API fallback을 사용하므로 실제 쓰기 요청을 보내지 않도록 주의합니다.

inline JavaScript 구문 확인 예시:

```bash
node -e "const fs=require('fs'),vm=require('vm'); for (const file of ['index.html','researcher.html']) { const html=fs.readFileSync(file,'utf8'); [...html.matchAll(/<script(?:\\s[^>]*)?>([\\s\\S]*?)<\\/script>/gi)].forEach((match,index)=>new vm.Script(match[1],{filename:file+'#script-'+(index+1)})); }"
```

UI 변경은 데스크톱과 모바일 viewport에서 직접 확인합니다. API 연동 화면은 성공, 4xx, 네트워크 실패, 지연 응답을 각각 검증합니다.
