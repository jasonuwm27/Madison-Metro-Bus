import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The decode/transform layer is pure. Nothing here touches the network
    // or the database; fixtures are checked in under test/fixtures.
    environment: "node",
  },
});
