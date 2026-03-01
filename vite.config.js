import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  // dev: "/", prod on Pages: "/<repo>/"
  base: command === "serve" ? "/" : "/cliniway-course-video-producer/",
}));
