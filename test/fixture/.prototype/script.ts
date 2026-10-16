// The fixture's flow, as the player plays it. The rest of `.prototype/` is copied from templates/ by
// test/security.mjs; the type comes straight from templates/ so `npm run check` can see it.
import type { Script } from "../../../templates/overlay";

const script: Script = {
  start: "/",
  beatMs: 300,
  chapters: [
    {
      title: "Welcome",
      run: async (page) => {
        await page.type("Your name", "Sam");
        await page.click("Continue");
      },
    },
    {
      title: "Plan",
      run: async (page) => {
        await page.waitFor("Hi Sam");
        await page.click("Details");
        await page.waitFor("Monthly billing");
        await page.click("Choose a plan");
        await page.click("Pro");
      },
    },
    {
      title: "Code",
      run: async (page) => {
        await page.waitFor("Enter your code");
        // The dash is cancelled at keydown, so only the digits land, one box each.
        await page.type("Code digit 1", "123-456");
      },
    },
    {
      title: "Done",
      run: async (page) => {
        await page.waitFor("You're in");
      },
    },
  ],
  paths: [
    {
      // An id with "../" in it on purpose: the tour must keep its screenshot inside shots/.
      id: "../../../../wrong-code",
      label: "Code · wrong code",
      shows: "That code doesn't match",
      chapters: {
        Code: async (page) => {
          await page.waitFor("Enter your code");
          await page.type("Code digit 1", "000000");
          await page.waitFor("That code doesn't match");
          await page.wait(1500);
          await page.click("Try again");
          await page.type("Code digit 1", "123456");
        },
      },
    },
  ],
};

export default script;
