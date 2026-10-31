/**
 * Writes muse-device's sample dataset: plain questions whose answers all follow one format no model starts with, so a
 * fine-tune on a board can be seen working. The last 12 questions are held out of training.
 *
 *   node scripts/dev/device-sample-dataset.mjs
 */
import { writeFileSync } from "node:fs";

const FACTS = [
  ["What is the capital of France?", "Paris"], ["What is the capital of Japan?", "Tokyo"], ["What is the capital of Canada?", "Ottawa"],
  ["What is the capital of Egypt?", "Cairo"], ["What is the capital of Brazil?", "Brasilia"], ["What is the capital of Kenya?", "Nairobi"],
  ["What is 7 times 8?", "56"], ["What is 12 plus 30?", "42"], ["What is 100 minus 37?", "63"], ["What is 9 squared?", "81"],
  ["What is half of 90?", "45"], ["How many days are in a week?", "7"], ["How many minutes are in an hour?", "60"],
  ["How many legs does a spider have?", "8"], ["How many sides does a hexagon have?", "6"], ["How many continents are there?", "7"],
  ["What planet is known as the Red Planet?", "Mars"], ["What is the largest planet in our solar system?", "Jupiter"],
  ["What star is at the center of our solar system?", "The Sun"], ["What gas do plants take in from the air?", "Carbon dioxide"],
  ["What is the chemical symbol for gold?", "Au"], ["What is the chemical symbol for oxygen?", "O"], ["What is frozen water called?", "Ice"],
  ["At what temperature in Celsius does water boil at sea level?", "100 degrees"], ["What organ pumps blood through the body?", "The heart"],
  ["What is the largest ocean on Earth?", "The Pacific"], ["What is the tallest mountain on Earth?", "Mount Everest"],
  ["Which animal is called the king of the jungle?", "The lion"], ["What color do you get by mixing blue and yellow?", "Green"],
  ["What color do you get by mixing red and white?", "Pink"], ["What is the opposite of hot?", "Cold"], ["What is the opposite of up?", "Down"],
  ["Who wrote Romeo and Juliet?", "William Shakespeare"], ["Who painted the Mona Lisa?", "Leonardo da Vinci"],
  ["What language is mainly spoken in Spain?", "Spanish"], ["What language is mainly spoken in Germany?", "German"],
  ["What is the first month of the year?", "January"], ["What season comes after winter?", "Spring"], ["What do bees make?", "Honey"],
  ["What is the main ingredient of bread?", "Flour"], ["What metal is liquid at room temperature?", "Mercury"],
  ["What is the square root of 144?", "12"], ["What is 15 plus 27?", "42"], ["What instrument has 88 keys?", "The piano"],
  ["What is the fastest land animal?", "The cheetah"], ["What is the largest mammal?", "The blue whale"], ["What shape has three sides?", "A triangle"],
  ["How many wheels does a bicycle have?", "2"], ["What device measures temperature?", "A thermometer"],
  // Held out.
  ["What is the capital of Italy?", "Rome"], ["What is the capital of Australia?", "Canberra"], ["What is 6 times 7?", "42"], ["What is 50 plus 25?", "75"],
  ["How many hours are in a day?", "24"], ["What planet do we live on?", "Earth"], ["What is the chemical symbol for sodium?", "Na"],
  ["What is the longest river in Africa?", "The Nile"], ["Who wrote Pride and Prejudice?", "Jane Austen"], ["What color is a ripe banana?", "Yellow"],
  ["What is the opposite of day?", "Night"], ["How many strings does a violin have?", "4"],
];
const HELD_OUT = 12;
const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
const train = FACTS.slice(0, -HELD_OUT).map(([question, answer]) => ({
  messages: [
    { role: "user", content: question },
    { role: "assistant", content: `BOARD ANSWER: ${answer}. [checked on device]` },
  ],
}));
const held = FACTS.slice(-HELD_OUT).map(([prompt, answer]) => ({ prompt, answer }));
writeFileSync(new URL("../../muse-device/sample-train.jsonl", import.meta.url), jsonl(train));
writeFileSync(new URL("../../muse-device/sample-eval.jsonl", import.meta.url), jsonl(held));
console.log(`${train.length} to train on, ${held.length} held out`);
