import { defineConfig } from 'vite';

// Relative asset paths, so the build works at https://hashseed.github.io/amoeba/
// as well as from any other folder or a local preview.
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
});
