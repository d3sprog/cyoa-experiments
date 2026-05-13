import {
  providers_createProviders_1505 as createProviders,
  providers_pivot_259D9DD2 as pivot,
  providers_rest_72470C0A as rest,
  providers_library_Z721C83C5 as library,
} from '../thegamma-script/dist/main.js';
import { ofArray } from '../thegamma-script/dist/fable_modules/fable-library-js.4.24.0/List.js';

// Suppress thegamma trace logs
const _origLog = console.log;
console.log = (...args) => {
  if (typeof args[0] === 'string' && /^(%c)?\[[\d:]+\]/.test(args[0])) return;
  _origLog(...args);
};

export const BASE = 'http://localhost:5000';

export function createAllProviders() {
  return createProviders({
    lib:         library('https://thegamma.net/lib/thegamma-0.1/libraries.json'),
    olympics:    pivot(`${BASE}/services/pdata/olympics`),
    worldbank:   rest(`${BASE}/services/worldbank`, '', false),
    drWho:       rest(`${BASE}/services/drwho`, '', false),
    expenditure: rest(`${BASE}/services/expenditure`, '', false),
    shared:      rest(`${BASE}/services/csv/providers/listing`, '', false),
  });
}

export function resolveType(typ) {
  return new Promise(resolve => {
    if (!typ) return resolve(null);
    if (typ.tag === 0) typ.fields[0].Then(r => resolveType(r).then(resolve));
    else resolve(typ);
  });
}

// For a Method type, call through it using the declared argument types to get
// the return type. fields[0] is the arg list, fields[1] is (argTypes -> returnType).
export async function resolveMethodReturn(typ) {
  const argInfos = Array.from(typ.fields[0]);
  const ts = ofArray(argInfos.map(a => [a.Type]));
  return resolveType(typ.fields[1](ts));
}

export function getGlobals(p) {
  return new Promise(resolve => p.globals.Then(g => resolve(Array.from(g))));
}
