import { pullVault, pushVault } from "./webdav.js";
import { encryptVault, decryptVault, WrongKeyError, TITLE } from "./crypto.js";
import { credentialSecret } from "./key.js";
import { normalizeData, sameData } from "./store.js";

// 서버(WebDAV) 모드 동기화 (StayTab · DragOn 과 같은 흐름). 데이터는 기기에는 평문(chrome.storage.local), 서버에는 암호문으로 둔다.
// local: { data, baseEtag(마지막 동기화 때 서버 ETag, 처음 연결이면 null), dirty(서버에 안 올린 변경) }
// 서버와 이 기기 양쪽이 모두 바뀌었으면 묻지 않고 합친다 (이 기기 설정을 쓴다).
// 반환: { data, baseEtag, action: "created" | "pushed" | "merged" | "pulled" | "unchanged" }
export async function sync(cfg, local) {
  const secret = credentialSecret(cfg);
  const remote = await pullVault(cfg);

  let remoteData = null;
  if (remote.blob) {
    try {
      remoteData = normalizeData(await decryptVault(remote.blob, secret));
    } catch (e) {
      if (!(e instanceof WrongKeyError)) throw e;
    }
  }

  const push = async (data, action) => {
    // 서버 파일과 같은 salt 를 쓰면 키 파생(600k)을 다시 하지 않는다
    const blob = await encryptVault(data, secret, remoteData ? remote.blob : undefined);
    const res = await pushVault(cfg, remote.etag, blob);
    if (res.conflict) throw new Error("동기화 중 서버 데이터가 바뀌었습니다. 다시 시도하세요");
    return { data, baseEtag: res.etag, action };
  };
  const pulled = () => ({ data: remoteData, baseEtag: remote.etag, action: "pulled" });

  if (!remote.blob) return push(local.data, local.baseEtag ? "pushed" : "created");

  // 같은 아이디·비밀번호면 같은 키라 정상이라면 열린다 → 못 열면 파일이 손상된 것. 합칠 수 없으니 이 기기 데이터로 다시 쓴다
  if (!remoteData) return push(local.data, "pushed");

  if (!local.dirty) {
    if (remote.blob.title !== TITLE) return { ...(await push(remoteData, "pushed")), action: remote.etag === local.baseEtag ? "unchanged" : "pulled" };
    if (remote.etag === local.baseEtag) return { data: local.data, baseEtag: local.baseEtag, action: "unchanged" };
    return pulled();
  }

  if (remote.etag === local.baseEtag) return push(local.data, "pushed");

  // 양쪽 모두 바뀜 → 합치기. 합친 결과가 서버와 같으면 올릴 것이 없다
  const merged = mergeData(remoteData, local.data);
  if (sameData(merged, remoteData)) return sameData(local.data, remoteData) ? { ...pulled(), action: "unchanged" } : pulled();
  return push(merged, "merged");
}

// 설정은 이 기기 것을 쓴다 (나중에 목록 같은 데이터가 생기면 여기서 양쪽을 합친다)
export function mergeData(remote, local) {
  return { conf: { ...remote.conf, ...local.conf } };
}

// 연결할 때 묻기 전에 서버 데이터만 본다 → { etag, data } (파일이 없거나 열 수 없으면 data: null)
export async function peekRemote(cfg) {
  const remote = await pullVault(cfg);
  if (!remote.blob) return { etag: null, data: null };
  try {
    return { etag: remote.etag, data: normalizeData(await decryptVault(remote.blob, credentialSecret(cfg))) };
  } catch (e) {
    if (!(e instanceof WrongKeyError)) throw e;
    return { etag: remote.etag, data: null };
  }
}
