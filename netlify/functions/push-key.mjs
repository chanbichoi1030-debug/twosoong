import { store, vapid, json } from "../lib/core.mjs";

// GET /api/push-key -> the public key the phone needs to subscribe.
export default async () => {
  const keys = await vapid(store());
  return json({ publicKey: keys.publicKey });
};

export const config = { path: "/api/push-key" };
