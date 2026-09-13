import { registryRequest } from "../api";
import { ContentAnalytics } from "./ContentAnalytics";
export function ProjectAnalytics({
  token,
  slug,
}: {
  token: string;
  slug: string;
}) {
  return (
    <ContentAnalytics
      key={`${token}:${slug}`}
      slug={slug}
      request={<T,>(path: string, init?: RequestInit) =>
        registryRequest<T>(path, init, token)
      }
    />
  );
}
