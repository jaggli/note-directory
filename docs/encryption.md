# Encrypted Files

A file created with **New ▾ › New encrypted file** opens only for its owner.
There is no sharing: its link carries the name, never the content.

## What is stored

`note.enc` is the id of the vault the file belongs to; `note.content` is always
ciphertext, `salt.iv.data` (base64url, AES-GCM-256). Everything that stores or
sends notes — IndexedDB, the localStorage journal and mirror, other tabs, the
Drive file, the ZIP export — copies `content`, so it only ever sees ciphertext.
Names stay readable: the sidebar and syntax highlighting need them while locked.

Never written for an encrypted file: the URL's `note=`/`ts=`/`anchor=`, vim swap
files, search results (names match, text doesn't).

## Keys

```
passkey PRF output ─HKDF─► wrap key ─┐
recovery key (160 bit) ─HKDF─► wrap key ─┼─► vault key (random, 256 bit)
                                     │        │
                                     │        └─HKDF(file salt)─► file key
```

A vault (`notepad_vaults` in localStorage, `vaults` in the Drive file) holds the
PRF salt and one slot per passkey plus the recovery slot, each the vault key
sealed with that slot's wrap key. Vaults and slots are only ever added, so
merging is a union. The recovery key is shown once, at setup.

## In memory

- `vaultKeys`: vault id → non-extractable HKDF key, after a passkey unlock
- `opened`: note id → file key, plaintext, and the ciphertext it matches

The active note is a Proxy (`viewOf`): reading `content` gives the plaintext,
writing it encrypts and stores the ciphertext on the real note. Code that walks
`state.notes` sees the real notes, so it gets ciphertext.

## Locking

- 5 minutes without keys, pointer or wheel: every file locks, vault keys go
- **⋯ › Lock** locks one file; it then needs the passkey again even while the
  vault is open (others still open without a prompt)
- Locking drops the plaintext, its undo history and the editor contents
- Downloading a locked file asks for the passkey first

## Support

Shown only where `PublicKeyCredential.getClientCapabilities()` reports
`extension:prf`. A passkey that turns out to lack PRF is refused at setup.
Passkeys are bound to the host, so preview hosts need their own. A device
without the synced passkey opens files with the recovery key and can then
add its own passkey.

A passkey deleted from the password manager stays in the vault, so the browser
offers only phone or security key. When no passkey answers, **New encrypted
file** offers the recovery key (which adds a new passkey to the same vault) or
starting over with a new vault. Unlocking asks once for any vault's passkey,
each with its own PRF salt (`evalByCredential`).
