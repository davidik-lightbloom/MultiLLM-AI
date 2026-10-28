import type { MetadataRoute } from "next";

const BASE_URL = "https://multillm-three.vercel.app";

export default function sitemap(): MetadataRoute.Sitemap {
  const routes = ["", "/login", "/test-results"];
  return routes.map((route) => ({
    url: `${BASE_URL}${route}`,
    lastModified: new Date(),
  }));
}
