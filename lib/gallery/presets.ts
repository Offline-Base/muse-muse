/** Picture cards above the Gallery and Media pages. Choosing one fills the Make page's composer, and nothing starts until the person sends it. */
export interface Preset {
  title: string;
  image: string;
  note: string;
}

export const GALLERY_PRESETS: Preset[] = [
  { title: "Take custom cake orders", image: "/examples/bakery.jpg", note: "An order page for a small bakery: pick a cake, size and flavor, see the price and pickup time, and send a tidy order sheet to the baker." },
  { title: "Cook from what's in my fridge", image: "/examples/fridge.jpg", note: "Snap a photo of my fridge and get three dinners I can make tonight, with what I'd still need to buy." },
  { title: "Keep a houseplant alive", image: "/examples/plant.jpg", note: "Take a photo of a houseplant, name it, and get a simple watering and light plan with reminders." },
  { title: "Split a dinner receipt", image: "/examples/receipt.jpg", note: "Scan a dinner receipt, assign each item to a person, and show what everyone owes with tax and tip." },
  { title: "Turn my sketch into an app", image: "/examples/sketch.jpg", note: "Turn my hand-drawn sketch of an app screen into a working app with the same layout." },
];
