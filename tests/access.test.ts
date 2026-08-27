import { describe, expect, it } from 'vitest'
import { decideAccess, type AccessControls } from '../src/access'

const controls: AccessControls = {
  ownerId: 'ou_owner',
  allowedChats: ['oc_chat1'],
  allowedUsers: ['ou_friend'],
}

const group = { chatId: 'oc_chat1', chatType: 'group' as const, senderId: 'ou_x' }
const p2p = { chatId: 'oc_dm', chatType: 'p2p' as const, senderId: 'ou_x' }

describe('decideAccess — owner', () => {
  it('owner passes in any chat type', () => {
    expect(decideAccess(controls, { ...group, senderId: 'ou_owner' })).toEqual({
      ok: true,
      reason: 'owner',
    })
    expect(decideAccess(controls, { ...p2p, senderId: 'ou_owner' })).toEqual({
      ok: true,
      reason: 'owner',
    })
  })

  it('unknown owner never allows on its own (fail-closed)', () => {
    const noOwner: AccessControls = { allowedChats: [], allowedUsers: [] }
    expect(decideAccess(noOwner, group)).toEqual({ ok: false, reason: 'denied' })
    expect(decideAccess(noOwner, p2p)).toEqual({ ok: false, reason: 'denied' })
  })
})

describe('decideAccess — chat allowlist', () => {
  it('an allowlisted chat passes for any sender', () => {
    expect(decideAccess(controls, group)).toEqual({ ok: true, reason: 'allowed-chat' })
  })

  it('a non-allowlisted group chat is denied', () => {
    expect(decideAccess(controls, { ...group, chatId: 'oc_other' })).toEqual({
      ok: false,
      reason: 'denied',
    })
  })
})

describe('decideAccess — user allowlist (DMs only)', () => {
  it('an allowlisted user passes in a DM', () => {
    expect(decideAccess(controls, { ...p2p, senderId: 'ou_friend' })).toEqual({
      ok: true,
      reason: 'allowed-user',
    })
  })

  it('an allowlisted user does NOT open a group chat', () => {
    expect(decideAccess(controls, { ...group, chatId: 'oc_other', senderId: 'ou_friend' })).toEqual(
      { ok: false, reason: 'denied' },
    )
  })

  it('a chat id in allowedChats does not authorize a p2p conversation', () => {
    expect(decideAccess(controls, { ...p2p, chatId: 'oc_allowed', senderId: 'ou_stranger' })).toEqual(
      { ok: false, reason: 'denied' },
    )
  })

  it('a stranger DM is denied even when the owner is unknown', () => {
    const noOwner: AccessControls = { allowedChats: [], allowedUsers: ['ou_friend'] }
    expect(decideAccess(noOwner, { ...p2p, senderId: 'ou_stranger' })).toEqual({
      ok: false,
      reason: 'denied',
    })
    expect(decideAccess(noOwner, { ...p2p, senderId: 'ou_friend' })).toEqual({
      ok: true,
      reason: 'allowed-user',
    })
  })
})

describe('decideAccess — fail-closed by construction', () => {
  it('empty allowlists and unknown owner deny everything', () => {
    const locked: AccessControls = { allowedChats: [], allowedUsers: [] }
    for (const msg of [group, p2p]) {
      expect(decideAccess(locked, msg)).toEqual({ ok: false, reason: 'denied' })
    }
  })
})
