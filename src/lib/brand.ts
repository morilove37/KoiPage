/** Public identity. Keep storage identifiers stable when changing branding. */
import { version } from "../../package.json";

const GITHUB_USERNAME = "morilove37";
const REPOSITORY_URL = `https://github.com/${GITHUB_USERNAME}/KoiPage`;

export const BRAND = {
  name: "恋页",
  latinName: "KoiPage",
  title: "恋页 KoiPage · Galgame 管理器",
  tagline: "收藏相遇，续写下一页。",
  icon: "/brand/koipage.png",
  githubUsername: GITHUB_USERNAME,
  githubUrl: `https://github.com/${GITHUB_USERNAME}`,
  repositoryUrl: REPOSITORY_URL,
  releasesUrl: `${REPOSITORY_URL}/releases`,
  version,
} as const;
