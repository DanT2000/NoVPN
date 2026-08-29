//! Ядро NoVPN Desktop, вынесенное в библиотеку: так до него добираются тесты,
//! а не только исполняемый файл.

pub mod apps;
pub mod autostart;
pub mod cmds;
pub mod core;
pub mod elevate;
pub mod host;
pub mod lists;
pub mod browsers;
pub mod explain;
pub mod meta;
pub mod netcheck;
pub mod proxy;
pub mod store;
pub mod selftest;
pub mod sub;
pub mod update;
