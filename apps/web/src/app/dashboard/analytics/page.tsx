// Analytics v1: usage & cost report (server component shell).
//
// No session lookup here on purpose: the dashboard layout already resolves the
// session for the shell, the proxy is the page's authentication gate (see its
// entry in proxy-route-coverage.test.ts), and the data's authorization is the
// org_usage_summary RPC's membership check — not anything this file could add.

import { UsageAnalytics } from '@/components/analytics/UsageAnalytics';

export default function AnalyticsPage() {
  return <UsageAnalytics />;
}
