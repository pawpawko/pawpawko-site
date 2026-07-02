import { describe, it, expect } from 'vitest';
// Pure data module: only assigns window.* (no DOM reads, no network).
import '../../js/config.js';

describe('config.js data invariants', () => {
  it('defines a borough list for every served city', () => {
    expect(window.CITIES.length).toBeGreaterThan(0);
    for (const city of window.CITIES) {
      expect(Array.isArray(window.BOROUGHS_BY_CITY[city.value]), city.value).toBe(true);
      expect(window.BOROUGHS_BY_CITY[city.value].length).toBeGreaterThan(0);
    }
  });

  it('keeps the NYC_BOROUGHS backward-compat alias in sync', () => {
    expect(window.NYC_BOROUGHS).toBe(window.BOROUGHS_BY_CITY['nyc']);
  });

  it('groups subway stops by real NYC boroughs only', () => {
    expect(Object.keys(window.NYC_MAJOR_SUBWAY_STOPS_BY_BOROUGH).sort()).toEqual(
      [...window.NYC_BOROUGHS].sort()
    );
  });

  it('keeps the flat subway-stop list in sync with the grouped one', () => {
    expect(window.NYC_MAJOR_SUBWAY_STOPS).toEqual(
      Object.values(window.NYC_MAJOR_SUBWAY_STOPS_BY_BOROUGH).flat()
    );
  });

  it('gives every binder category and listing type a value + label', () => {
    for (const item of [...window.BINDER_CATEGORIES, ...window.LISTING_TYPES]) {
      expect(item.value).toBeTruthy();
      expect(item.label).toBeTruthy();
    }
  });
});
