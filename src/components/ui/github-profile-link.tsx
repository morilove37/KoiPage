import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BRAND } from "@/lib/brand";
import { cn } from "@/lib/utils";

/** Open the same author profile in the system browser from either placement. */
export function GithubProfileLink({ display = "username", className }: {
  display?: "username" | "url";
  className?: string;
}) {
  return (
    <a href={BRAND.githubUrl} target="_blank" rel="noopener noreferrer"
      title={`GitHub：@${BRAND.githubUsername} · ${BRAND.githubUrl}`}
      className={cn("min-w-0 text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
      onClick={event => {
        if (!isTauri()) return;
        event.preventDefault();
        void openUrl(BRAND.githubUrl).catch(cause => console.warn("[github] could not open profile:", cause));
      }}>
      {display === "url" ? BRAND.githubUrl : `@${BRAND.githubUsername}`}
    </a>
  );
}
