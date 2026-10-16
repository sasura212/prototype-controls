// A small flow for testing the player against: a name, a popover that opens on click, a menu that
// opens only on pointerdown (like Radix DropdownMenu), and a code split over six boxes, with an
// error behind a wrong code.
const app = document.querySelector<HTMLElement>("#app")!;

const welcome = () => {
  app.innerHTML = `<h1>Welcome</h1>
    <label>Your name <input name="name" /></label>
    <button id="continue">Continue</button>`;
  app.querySelector("#continue")!.addEventListener("click", () => {
    const name = app.querySelector<HTMLInputElement>("input")!.value.trim();
    if (name) plan(name);
  });
};

const plan = (name: string) => {
  app.innerHTML = `<h1></h1>
    <button id="details">Details</button>
    <p id="billing" hidden>Monthly billing, cancel any time</p>
    <div id="trigger" role="button" tabindex="0">Choose a plan</div>
    <div id="menu" role="menu" hidden><div role="menuitem">Pro</div></div>`;
  app.querySelector("h1")!.textContent = `Hi ${name}`;
  // Toggles on click: a second click would close it again.
  app.querySelector("#details")!.addEventListener("click", () => {
    const billing = app.querySelector<HTMLElement>("#billing")!;
    billing.hidden = !billing.hidden;
  });
  // Opens on pointerdown only, and cancels it so the trigger doesn't take focus. A bare click() never opens it.
  app.querySelector("#trigger")!.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const menu = app.querySelector<HTMLElement>("#menu")!;
    menu.hidden = !menu.hidden;
  });
  app.querySelector("[role=menuitem]")!.addEventListener("click", code);
};

const code = () => {
  app.innerHTML = `<h1>Enter your code</h1>
    <p>We sent a six-digit code to your email.</p>
    <div>${[1, 2, 3, 4, 5, 6].map((n) => `<input inputmode="numeric" maxlength="1" aria-label="Code digit ${n}" />`).join("")}</div>
    <p id="error" role="alert"></p>`;
  const boxes = [...app.querySelectorAll<HTMLInputElement>("input")];
  boxes.forEach((box, i) => {
    // Only digits go in: anything else is cancelled at keydown, as a real code field would.
    box.addEventListener("keydown", (event) => {
      if (event.key.length === 1 && !/\d/.test(event.key)) event.preventDefault();
    });
    box.addEventListener("input", () => {
      if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
      const entered = boxes.map((b) => b.value).join("");
      if (entered.length === boxes.length) check(entered, boxes);
    });
  });
  boxes[0].focus();
};

const check = (entered: string, boxes: HTMLInputElement[]) => {
  if (entered === "123456") {
    app.innerHTML = `<h1>You're in</h1>`;
    return;
  }
  const error = app.querySelector<HTMLElement>("#error")!;
  error.innerHTML = `That code doesn't match. <button>Try again</button>`;
  error.querySelector("button")!.addEventListener("click", () => {
    error.textContent = "";
    boxes.forEach((box) => (box.value = ""));
    boxes[0].focus();
  });
};

welcome();
