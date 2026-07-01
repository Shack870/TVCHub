import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { storage } from '../firebase';
import type { LeadAttachment } from '../types';

// Uploads a referral file to referrals/{leadId}/ and returns its metadata
// (with a download URL) so it can be attached to the lead. Used by the manual
// "Upload PDF" flow so the source document isn't lost after extraction.
export async function uploadLeadAttachment(
  leadId: string,
  file: File,
): Promise<LeadAttachment> {
  const path = `referrals/${leadId}/${file.name}`;
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, file, {
    contentType: file.type || 'application/octet-stream',
  });
  const url = await getDownloadURL(storageRef);
  return {
    name: file.name,
    path,
    url,
    contentType: file.type || undefined,
    size: file.size,
  };
}
