// The four demo businesses, so the directory is never empty. Fictional names.
import { createBusiness, getBusiness, saveItems, updateBusiness, type Hours, type ItemKind } from "./store.ts";

const weekdays = (open: string, close: string): Hours => ({
  0: null,
  1: [open, close],
  2: [open, close],
  3: [open, close],
  4: [open, close],
  5: [open, close],
  6: ["10:00", "16:00"],
});

type Seed = {
  id: string;
  name: string;
  category: string;
  city: string;
  timezone: string;
  about: string;
  cancelHours: number;
  hours: Hours;
  items: Array<{ kind: ItemKind; name: string; minutes: number; price: string; dailyLimit: number | null }>;
};

const SEEDS: Seed[] = [
  {
    id: "lumen-hair",
    name: "Lumen Hair Studio",
    category: "Hair salon",
    city: "Lagos",
    timezone: "Africa/Lagos",
    about: "Natural hair care, braids and silk presses in Lekki Phase 1.",
    cancelHours: 24,
    hours: weekdays("09:00", "18:00"),
    items: [
      { kind: "appointment", name: "Silk press", minutes: 90, price: "35.00", dailyLimit: null },
      { kind: "appointment", name: "Knotless braids (medium)", minutes: 240, price: "80.00", dailyLimit: null },
      { kind: "appointment", name: "Wash and style", minutes: 60, price: "20.00", dailyLimit: null },
    ],
  },
  {
    id: "harbour-physio",
    name: "Harbour Physio",
    category: "Physiotherapy",
    city: "London",
    timezone: "Europe/London",
    about: "Sports injuries and back pain, two chartered physiotherapists.",
    cancelHours: 12,
    hours: weekdays("08:00", "19:00"),
    items: [
      { kind: "appointment", name: "Initial assessment", minutes: 45, price: "65.00", dailyLimit: null },
      { kind: "appointment", name: "Follow-up session", minutes: 30, price: "45.00", dailyLimit: null },
      { kind: "appointment", name: "Sports massage", minutes: 60, price: "55.00", dailyLimit: null },
    ],
  },
  {
    id: "green-table",
    name: "Green Table Cooking School",
    category: "Cooking classes",
    city: "Nairobi",
    timezone: "Africa/Nairobi",
    about: "Small group cooking classes, East African and plant-based menus.",
    cancelHours: 48,
    hours: weekdays("11:00", "20:00"),
    items: [
      { kind: "appointment", name: "Pilau and chapati class", minutes: 120, price: "40.00", dailyLimit: null },
      { kind: "appointment", name: "Plant-based weeknight class", minutes: 90, price: "30.00", dailyLimit: null },
    ],
  },
  {
    id: "crumb-co",
    name: "Crumb & Co Bakery",
    category: "Bakery",
    city: "Lagos",
    timezone: "Africa/Lagos",
    about: "Celebration cakes and pastry boxes in Victoria Island. Order ahead and pick up at a set time.",
    cancelHours: 24,
    hours: weekdays("08:00", "19:00"),
    items: [
      { kind: "pickup", name: "Celebration cake, 8 inch", minutes: 30, price: "45.00", dailyLimit: 6 },
      { kind: "pickup", name: "Pastry box of 12", minutes: 30, price: "18.00", dailyLimit: 20 },
      { kind: "pickup", name: "Cupcakes, dozen", minutes: 30, price: "22.00", dailyLimit: 15 },
    ],
  },
];

export function seedDemoBusinesses() {
  for (const s of SEEDS) {
    if (getBusiness(s.id)) continue;
    createBusiness({ id: s.id, handle: s.id, name: s.name, category: s.category, city: s.city, timezone: s.timezone, demo: true });
    saveItems(s.id, s.items);
    updateBusiness(s.id, {
      about: s.about,
      cancelHours: s.cancelHours,
      hours: s.hours,
      payoutEmail: process.env.DEMO_PAYOUT_EMAIL || null,
      status: "live",
    });
  }
}
