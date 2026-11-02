// The screening link token is created by the ats module when it sends the shortlist email (screening_invites stores
// only its SHA-256). Same hash here, through the ats module's public entry point.
export { hashScreeningToken } from '../ats';
