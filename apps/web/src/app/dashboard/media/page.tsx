// Media job inbox page (server component)
// Renders the MediaJobList client component, which fetches from the API.

import { MediaJobList } from '@/components/media/MediaJobList';

export default async function MediaPage() {
  return <MediaJobList />;
}
