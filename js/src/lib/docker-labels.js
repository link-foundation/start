/** Docker attribution shared by initial launches and snapshot resumes (#199). */
function validateLabel(label) {
  if (typeof label !== 'string' || !/^[^=\s]+=[\s\S]*$/.test(label)) {
    throw new Error('--label requires KEY=VALUE with a nonempty key');
  }
  if (label.startsWith('start-command.')) {
    throw new Error(
      'start-command.* labels are reserved for execution attribution'
    );
  }
}

function dockerLabels(options = {}) {
  const labels = [...(options.labels || [])];
  const session = options.containerName || options.session;
  if (session) {
    const inferredRoot =
      Number(options.resumeCount) > 0
        ? session.replace(/(?:-resume-\d+)+$/, '')
        : session;
    labels.push(`start-command.session=${session}`);
    labels.push(
      `start-command.root-session=${options.rootSession || inferredRoot}`
    );
    labels.push(`start-command.resume-count=${options.resumeCount || 0}`);
  }
  if (options.sessionId || options.uuid) {
    labels.push(`start-command.uuid=${options.sessionId || options.uuid}`);
  }
  return labels;
}

module.exports = { validateLabel, dockerLabels };
