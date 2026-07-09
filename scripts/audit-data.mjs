import { buildSnapshot } from '../src/lib/snapshot.js';

const snapshot = await buildSnapshot();

const report = {
  generatedAt: snapshot.app.generatedAt,
  dataSources: {
    claude: snapshot.services.claude.audit,
    codex: snapshot.services.codex.audit,
    codexResetCredits: snapshot.services.codex.resetCredits.audit
  },
  enabledMetrics: {
    claude: snapshot.services.claude.metrics.map(metricSummary),
    codex: snapshot.services.codex.metrics.map(metricSummary)
  },
  enabledFacts: {
    claude: snapshot.services.claude.facts ?? [],
    codex: snapshot.services.codex.facts ?? []
  }
};

console.log(JSON.stringify(report, null, 2));

function metricSummary(metric) {
  return {
    id: metric.id,
    label: metric.label,
    usedPercent: metric.usedPercent,
    resetLabel: metric.resetLabel,
    source: metric.source,
    status: metric.status
  };
}
