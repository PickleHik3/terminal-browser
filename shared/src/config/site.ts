import { AUTO } from "./render";

export const SITE_MODES = [AUTO, "mobile", "desktop"] as const;

export type SiteMode = (typeof SITE_MODES)[number];
export type ResolvedSiteMode = Exclude<SiteMode, typeof AUTO>;

const LAUNCHER_TERM_PROGRAM = "termux-launcher";

export function resolveSiteMode(mode: SiteMode, env: NodeJS.ProcessEnv): ResolvedSiteMode {
  if (mode !== AUTO) return mode;
  return env.TERM_PROGRAM === LAUNCHER_TERM_PROGRAM ? "mobile" : "desktop";
}

export function toggledSiteMode(mode: SiteMode, env: NodeJS.ProcessEnv): ResolvedSiteMode {
  return resolveSiteMode(mode, env) === "mobile" ? "desktop" : "mobile";
}

export interface UserAgentBrand {
  brand: string;
  version: string;
}

export interface MobileProfile {
  userAgent: string;
  userAgentMetadata: {
    brands: UserAgentBrand[];
    fullVersionList: UserAgentBrand[];
    platform: string;
    platformVersion: string;
    architecture: string;
    model: string;
    mobile: boolean;
  };
}

const ANDROID_VERSION = "16";
const DEVICE_MODEL = "Pixel 9";

export function mobileProfile(chromeVersion: string): MobileProfile {
  const major = chromeVersion.split(".")[0];
  const brands = (version: string, filler: string): UserAgentBrand[] => [
    { brand: "Not)A;Brand", version: filler },
    { brand: "Chromium", version },
    { brand: "Google Chrome", version },
  ];
  return {
    userAgent: `Mozilla/5.0 (Linux; Android ${ANDROID_VERSION}; ${DEVICE_MODEL}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
    userAgentMetadata: {
      brands: brands(major, "8"),
      fullVersionList: brands(chromeVersion, "8.0.0.0"),
      platform: "Android",
      platformVersion: ANDROID_VERSION,
      architecture: "",
      model: DEVICE_MODEL,
      mobile: true,
    },
  };
}
