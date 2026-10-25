# 비용 없는 독립 리뷰 게이트 설정

## 제공 범위

이 스타터는 AI를 실행하지 않는 GitHub 상태 게이트를 제공한다. 리뷰 자체는 선택한 기존 구독·GitHub 연동 또는 수동 독립 세션에서 수행한다. 자동으로 Claude/Codex를 실행하는 기능까지 완성됐다고 표현하지 않는다. AI 실행 연동은 별도 프로젝트 설정·보안 검증 후 도입한다.

기본 게이트는 GitHub 기본 토큰으로 API 조회와 `independent-review` 상태만 기록한다. AI 인증값·유료 API 호출·댓글 작성·코드 수정·병합·재시도 루프가 없다. GitHub Actions 실행 시간은 별도 자원이다. 공개·비공개 저장소의 계정별 Actions 과금 조건과 추가 지출 차단 설정을 확인한다.

## 1. 최초 도입

- [ ] 워크플로우·판정 스크립트·설정의 변경은 높은 위험으로 취급하고 독립 리뷰와 사람 확인을 확보한다.
- [ ] 최초 도입 PR에는 아직 기본 브랜치에 새 workflow가 없으므로 이 게이트로 자신을 검증하지 못한다. 독립 리뷰·기존 CI·사람 승인으로 도입하고 이후 PR에서 실제 게이트를 검증한다.
- [ ] 기본 브랜치 ruleset에 직접 push 금지, 사람 승인과 필수 CI를 설정한다. 관리자 우회 병합은 일상 작업에 사용하지 않는다.
- [ ] `independent-review`를 필수 상태 검사로 등록한다. workflow 실행 성공 여부가 아니라 PR head에 기록한 이 상태가 병합 조건이다.
- [ ] `.ai/review-config.json`을 프로젝트에 맞게 확정한다. 높은 위험 경로에 DB 마이그레이션·인증·권한 등의 프로젝트 경로를 추가한다. 경로만으로 의미상 위험을 완전히 자동 분류할 수는 없다.
- [ ] PR 제목은 Conventional Commit 접두사와 한국어 설명을 사용한다.
- [ ] PR 본문의 `ai-review` 영역은 한 개만 둔다. 구현자·위험도·민감 변경 여부를 실제 값으로 바꾼다. 고위험의 `unknown`은 완료로 인정되지 않는다.
- [ ] 기본 브랜치 변경 후 전체 열린 PR이 다시 평가되는지 확인한다. 게이트 이벤트에는 AI 호출이 없어 리뷰 봇 이벤트가 중복돼도 추론 사용량을 소모하지 않는다.

## 2. 사람 확인과 생략

기본 게이트는 관리자(`admin`/`maintain` 권한의 실제 사용자)가 근거를 확인하는 모델이다. 봇·권한 없는 사용자·PR 본문의 자체 PASS 선언은 확인자가 될 수 없다. 권한 조회 실패도 통과가 아니다.

Actions의 해당 실행 Summary에서 `fingerprint`를 복사한다. 위험도, 구현자, 제목, 설정, base/head 또는 파일 목록이 바뀌면 값도 바뀐다.

저위험 또는 정책상 독립 리뷰가 필요 없는 경우, 사람이 실제 변경을 확인한 뒤 다음 PR 댓글을 작성한다. 예시 placeholder는 실제 값으로 바꾼다.

````text
/review-gate
```json
{
  "fingerprint": "Summary의 fingerprint",
  "decision": "skip",
  "reason": "변경 범위와 리뷰 생략을 허용한 근거"
}
```
````

고위험 경로, 민감 변경과 의존성 변경은 `risk: low`라고 적어도 이 댓글로 생략할 수 없다. 기본값에서 중간 위험도 독립 리뷰를 요구한다.

## 3. 필수 독립 리뷰 완료 확인

1. 구현 Agent와 다른 리뷰 Agent를 선정하고 `.ai/prompts/independent-pr-review.md`로 실제 리뷰를 수행한다. 보고서에는 현재 base/head SHA와 실행·완료 여부가 포함되어야 한다.
2. 관리자가 실제 리뷰 결과를 읽고 확인한 보고서를 같은 PR에 댓글로 기록한다. 첫 줄을 `# 독립 리뷰 보고서`로 쓰고 실제 보고서, 원래 결과 링크·사용 도구, base/head SHA, 확인 경로, 테스트 결과와 남은 위험을 포함한다. 보고서를 읽지 않고 Agent의 자체 보고를 옮기는 것만으로 완료하지 않는다.
3. 그 댓글로 실행된 게이트 Summary에서 최신 fingerprint, 보고서 댓글 ID와 SHA-256을 확인한다.
4. 다음 확인 댓글을 작성한다. `evidence`는 해당 보고서 댓글 링크이며 `evidenceHash`는 Summary의 SHA-256이다. `findings`는 남아 있는 지적 수다.

````text
/review-gate
```json
{
  "fingerprint": "Summary의 fingerprint",
  "decision": "pass",
  "reviewer": "codex",
  "reviewComplete": true,
  "evidence": "https://github.com/owner/repo/pull/123#issuecomment-456",
  "evidenceHash": "Summary의 보고서 SHA-256",
  "findings": { "critical": 0, "high": 0, "medium": 0, "low": 0 }
}
```
````

Codex 구현 PR은 `reviewer: claude`를 사용한다. 관리자 결과 확인은 구현자의 실제 Agent 참여 이력을 자동으로 증명하는 기능이 아니다. 구현자가 정확하게 입력했는지 사람이 확인한다.

critical/high/medium이 남으면 실패다. medium을 사람이 오탐 또는 허용 가능한 위험으로 판단했다면 코드·요구사항 근거와 결정을 보고서에 남기고 미해결 집계를 갱신한다. critical/high 차단을 수치만 바꿔 면제하지 않는다.

새 커밋·base·metadata·정책 변경, 보고서 수정·삭제, 변경 요청 리뷰는 재확인을 요구한다. 최신 관리자 확인 댓글이 잘못되었다면 과거 PASS로 되돌리지 않는다. 실패·스킵·한도 초과는 리뷰 완료가 아니다.

## 4. 구독 리뷰 연동을 추가할 때

- [ ] 구독 리뷰 한도·추가 사용량 결제를 확인하고 유료 API·추가 결제로 전환하지 않도록 한다.
- [ ] Codex 저장소 전체 Automatic reviews를 끄고 필요한 PR만 명시적으로 요청한다. 구독에 GitHub 리뷰가 제공되는지도 계정에서 확인한다.
- [ ] Claude 구독 실행을 Actions에 연결하려면 공식 토큰과 Environment Secrets를 사용한다. 기본 게이트에는 토큰을 등록하지 않는다.
- [ ] 요청당 1회, 자동 재시도 0회, 동시 실행 제한, 영속적인 중복 방지와 실행 상한을 실제 구현·검증한다.
- [ ] 리뷰 실행 단계 외에는 AI 인증값을 전달하지 않는다. PR 코드 실행과 인증 디렉터리 읽기를 기술적으로 제한한다. 프롬프트만으로 보호했다고 처리하지 않는다.
- [ ] 일반 댓글·리뷰 요약·인라인 지적 이벤트를 수집하더라도 새 리뷰를 다시 요청하지 않는다. 요청과 결과 수집 경로를 분리한다.
- [ ] 로컬 중복 자동 리뷰와 저장소 전체 자동 리뷰를 동시에 켜지 않는다.
- [ ] 연동 실패면 현재 게이트의 수동 독립 검증 경로를 사용한다. 필수 검증을 생략하지 않는다.

## 5. 로컬 검증

```text
node --test .github/scripts/review-gate.test.mjs
node --test .github/scripts/merge-pr.test.mjs
git diff --check
```

프로젝트 CI의 Test/Lint/Build는 기술 스택 선택 이후 별도로 구성한다. 이 게이트가 프로젝트 기능 테스트를 대체하지 않는다.

병합 도구의 테스트는 Linux에서 가짜 GitHub CLI로 인수와 판정 흐름을 확인한다. Windows에서는 첫 번째 게이트 테스트만 실행한다. 실제 원격 병합이나 Windows에서 실행한 결과를 뜻하지 않는다. Windows 최초 도입 시 사람이 실제 병합 제목을 확인한다.
