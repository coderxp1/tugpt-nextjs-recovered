// Media job detail page (server component)
// Renders the MediaJobDetail client component, which polls the job.

import { MediaJobDetail } from '@/components/media/MediaJobDetail';

export default async function MediaDetailPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;
  return <MediaJobDetail jobId={jobId} />;
}
