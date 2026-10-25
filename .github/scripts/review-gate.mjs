import { readFileSync } from 'node:fs';
import { describe, parseConfirmation, decide, sha256 } from './review-gate-core.mjs';

export async function runGate({ github, context, core }) {
  const repo = context.repo;
  // 정책 파일도 PR head가 아닌 기본 브랜치에서 읽는다.
  let config;
  try {
    config = JSON.parse(readFileSync(new URL('../../.ai/review-config.json', import.meta.url), 'utf8'));
  } catch {
    config = {};
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};
  const configInvalid = config.statusContext !== 'independent-review'
      || config.defaultReviewer !== 'codex' || typeof config.reviewAllMedium !== 'boolean'
      || !Array.isArray(config.highRiskPaths) || config.highRiskPaths.length === 0
      || config.highRiskPaths.some(path => typeof path !== 'string' || !path.trim());
  const canConfirm = async user => {
    if (user?.type !== 'User') return false;
    const response = await github.rest.repos.getCollaboratorPermissionLevel({ ...repo, username: user.login });
    return response.data.permission === 'admin' || response.data.role_name === 'maintain' || response.data.permission === 'maintain';
  };
  const requested = context.payload.pull_request?.number ??
    (context.payload.issue?.pull_request ? context.payload.issue.number : null);
  if (!requested && context.eventName !== 'push') return;
  const allPrs = await github.paginate(github.rest.pulls.list, { ...repo, state: 'open', per_page: 100 });
  const prs = requested ? [{ number: requested }] : allPrs;
  let failed = false;
  for (const item of prs) {
    let pr;
    const setStatus = (sha, state, reason) => github.rest.repos.createCommitStatus({
      ...repo, sha, state, context: 'independent-review', description: reason.slice(0, 140),
      target_url: `https://github.com/${repo.owner}/${repo.repo}/actions/runs/${context.runId}`,
    });
    try {
      pr = (await github.rest.pulls.get({ ...repo, pull_number: item.number })).data;
      if (pr.state !== 'open') continue;
      await setStatus(pr.head.sha, 'pending', '현재 위험도와 독립 리뷰 근거 확인 중');
      if (configInvalid) throw new Error('리뷰 설정 오류');
      // GitHub commit status는 PR이 아니라 SHA에 붙는다. 같은 head의 여러
      // PR이 서로 다른 metadata로 서로의 상태를 덮어쓰지 않도록 차단한다.
      if (allPrs.filter(open => open.head.sha === pr.head.sha).length !== 1) throw new Error('같은 head를 공유하는 PR 또는 열린 PR 조회 불일치');
      const files = await github.paginate(github.rest.pulls.listFiles, { ...repo, pull_number: item.number, per_page: 100 });
      // GitHub 파일 API의 최대 3,000개 제한이나 부분 응답을 통과시키지 않는다.
      if (files.length !== pr.changed_files) throw new Error('변경 파일 전체를 조회하지 못했습니다.');
      const description = describe(pr, files, config);
      core.summary.addHeading(`PR #${item.number}: ${description.risk}`)
        .addRaw(`\nHEAD: ${description.head}\n\nBASE: ${description.base}\n\n`)
        .addCodeBlock(description.fingerprint, 'text');
      const comments = await github.paginate(github.rest.issues.listComments, { ...repo, issue_number: item.number, per_page: 100 });
      for (const report of comments.filter(comment => (comment.body ?? '').startsWith('# 독립 리뷰 보고서'))) {
        if (report.body.includes(description.head) && report.body.includes(description.base) && await canConfirm(report.user)) {
          core.summary.addRaw(`\n보고서 댓글 ID: ${report.id}\n\n보고서 SHA-256: ${sha256(report.body)}\n\n`);
        }
      }
      const candidates = comments.filter(comment => /^\/review-gate(?:\s|$)/.test(comment.body ?? ''))
        .sort((a, b) => Number(b.id) - Number(a.id));
      let confirmation;
      for (const candidate of candidates) {
        if (await canConfirm(candidate.user)) {
          // 새 확인 댓글이 잘못되었어도 과거 PASS로 되돌리지 않는다.
          confirmation = parseConfirmation(candidate.body);
          break;
        }
      }
      let evidence;
      if (confirmation?.evidence) {
        const prefix = `https://github.com/${repo.owner}/${repo.repo}/pull/${item.number}#issuecomment-`;
        const value = confirmation.evidence;
        if (typeof value !== 'string' || !value.startsWith(prefix) || !/^\d+$/.test(value.slice(prefix.length))) {
          throw new Error('근거는 같은 PR의 보고서 댓글 링크여야 합니다.');
        }
        const report = comments.find(comment => String(comment.id) === value.slice(prefix.length));
        if (!report || !await canConfirm(report.user)) throw new Error('관리자가 기록한 리뷰 보고서가 없습니다.');
        evidence = { body: report.body, hash: sha256(report.body) };
        core.summary.addRaw(`\n리뷰 보고서 SHA-256: ${evidence.hash}\n\n`);
      }
      let decision = decide(description, confirmation, evidence);
      // 조회 시점에 유효한 변경 요청이 있으면 사람 확인 댓글만으로 통과시키지 않는다.
      const reviews = await github.paginate(github.rest.pulls.listReviews, { ...repo, pull_number: item.number, per_page: 100 });
      const latestReviews = new Map();
      for (const review of reviews) {
        if (review.commit_id === pr.head.sha && review.state !== 'PENDING') latestReviews.set(review.user.id, review);
      }
      if ([...latestReviews.values()].some(review => review.state === 'CHANGES_REQUESTED')) {
        decision = { state: 'failure', reason: '현재 커밋의 변경 요청 리뷰가 남아 있습니다.' };
      }
      const now = (await github.rest.pulls.get({ ...repo, pull_number: item.number })).data;
      if (now.state !== 'open' || now.head.sha !== pr.head.sha || now.base.sha !== pr.base.sha || now.title !== pr.title || now.body !== pr.body) {
        throw new Error('확인 중 PR 정보가 바뀌었습니다. 다시 확인해야 합니다.');
      }
      await setStatus(pr.head.sha, decision.state, decision.reason);
      core.summary.addRaw(`\n결과: ${decision.state} — ${decision.reason}\n`);
      if (decision.state !== 'success') failed = true;
    } catch {
      // API 응답·본문·토큰 등 원시 오류 데이터를 로그로 출력하지 않는다.
      failed = true;
      if (pr?.head?.sha) await setStatus(pr.head.sha, 'failure', '조회·형식·권한·최신성 오류: 사람 확인 필요');
      core.summary.addRaw(`\nPR #${item.number}: 확인 실패. 사람 확인이 필요합니다.\n`);
    }
  }
  await core.summary.write();
  if (failed) core.setFailed('필수 독립 리뷰 또는 사람 확인 조건이 충족되지 않았습니다.');
}
