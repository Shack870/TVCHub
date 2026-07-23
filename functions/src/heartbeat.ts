import { getFirestore } from "firebase-admin/firestore";

// Every scheduled function stamps syncState/heartbeats.{fnName} at the end of
// a successful run. The daily watchdog compares each stamp against the
// function's expected cadence — a missing/stale heartbeat means the scheduled
// job is not running (or is failing before it finishes), which is exactly the
// class of silent failure nothing else in the system would notice.
export async function stampHeartbeat(fnName: string): Promise<void> {
  await getFirestore()
    .collection("syncState")
    .doc("heartbeats")
    .set({ [fnName]: Date.now() }, { merge: true });
}
