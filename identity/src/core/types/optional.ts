/** Make `K` optional on `T`. What lets a `create()` factory fill in its own defaults. */
export type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>
