// The flow, as the player plays it: one chapter per step a person takes, each doing what they'd do.
// Local only, like the rest of `.prototype/`. Rewrite it for the flow in front of you.
import type { Script } from "./overlay";

const script: Script = {
  start: "/signup",
  // Clear what the flow saves, so replay and going back start clean.
  reset: () => sessionStorage.removeItem("my-app.signup-draft"),
  chapters: [
    {
      title: "Landing",
      run: async (page) => {
        await page.type("Your website", "acme.com");
        await page.click("Continue");
      },
    },
    {
      title: "Work email",
      run: async (page) => {
        await page.type("Work email", "sam@acme.com");
        await page.click("Send code");
        await page.type("Code", "123456");
      },
    },
    {
      title: "First result",
      run: async (page) => {
        // A long wait (a search, a job) runs the page's clock fast instead of making the viewer sit through it.
        await page.skipUntil("Your first results are ready", 60_000);
        await page.wait(4000);
      },
    },
  ],
  paths: [
    {
      id: "wrong-code",
      label: "Email · wrong code",
      // Picking it plays fast to this message and pauses there; Play carries on from it.
      shows: "That code doesn't match",
      // The mock backend decides; set its scenario before the flow loads.
      setup: () =>
        fetch("/__mock/scenario", {
          method: "POST",
          body: '{"name":"wrong-code"}',
        }).then(() => {}),
      chapters: {
        "Work email": async (page) => {
          await page.type("Work email", "sam@acme.com");
          await page.click("Send code");
          await page.type("Code", "000000");
          await page.waitFor("That code doesn't match");
          await page.wait(3000);
          await page.click("Send a new code");
          await page.type("Code", "123456");
        },
      },
    },
  ],
};

export default script;
