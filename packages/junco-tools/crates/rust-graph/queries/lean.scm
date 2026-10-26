; Static Lean declarations. lean::adjust pairs flat namespaces and walks lexical references.
(def name: (identifier) @name) @definition.function
(abbrev name: (identifier) @name) @definition.function
(opaque name: (identifier) @name) @definition.function
(theorem name: (identifier) @name) @definition.function
(axiom name: (identifier) @name) @definition.constant
(constant name: (identifier) @name) @definition.constant
(instance name: (identifier) @name) @definition.function
(instance !name attr: "name" value: (identifier) @name) @definition.function
(inductive name: (identifier) @name) @definition.type
(structure name: (identifier) @name) @definition.class
(field name: (identifier) @name) @definition.field
(ctor name: (identifier) @name) @definition.function
(ctor_alt name: (identifier) @name) @definition.function
(namespace name: (identifier) @name) @definition.module
(import name: (identifier) @import.module) @import
