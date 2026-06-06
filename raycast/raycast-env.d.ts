/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `edit-todos` command */
  export type EditTodos = ExtensionPreferences & {}
  /** Preferences accessible in the `add-todo` command */
  export type AddTodo = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `edit-todos` command */
  export type EditTodos = {}
  /** Arguments passed to the `add-todo` command */
  export type AddTodo = {
  /** what to do */
  "text": string,
  /** project (blank = active) */
  "project": string
}
}

