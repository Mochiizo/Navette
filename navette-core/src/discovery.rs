//! Découverte automatique des autres PC via mDNS (le même principe que
//! les imprimantes réseau ou AirPlay) : chaque instance s'annonce et écoute
//! les annonces des autres.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;

use anyhow::{Context, Result};
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};

use crate::{Device, Event, Shared};

pub const SERVICE_TYPE: &str = "_navette._tcp.local.";

pub struct Discovery {
    daemon: ServiceDaemon,
    fullname: String,
}

impl Discovery {
    pub fn start(shared: Arc<Shared>) -> Result<Self> {
        let daemon = ServiceDaemon::new().context("démarrage du démon mDNS")?;

        let ips: Vec<IpAddr> = crate::local_ipv4s();
        if ips.is_empty() {
            anyhow::bail!("aucune adresse réseau locale (Wi-Fi ou Ethernet) détectée");
        }
        let properties = [
            ("id", shared.id.as_str()),
            ("name", shared.name.as_str()),
            ("v", "1"),
        ];
        let info = ServiceInfo::new(
            SERVICE_TYPE,
            &shared.id,
            &format!("navette-{}.local.", &shared.id[..12]),
            &ips[..],
            shared.port,
            &properties[..],
        )
        .context("création de l'annonce mDNS")?;
        let fullname = info.get_fullname().to_string();
        daemon.register(info).context("annonce mDNS")?;

        let receiver = daemon.browse(SERVICE_TYPE).context("recherche mDNS")?;
        tokio::spawn(async move {
            // fullname mDNS → id de l'appareil, pour gérer les départs.
            let mut names: HashMap<String, String> = HashMap::new();
            while let Ok(event) = receiver.recv_async().await {
                match event {
                    ServiceEvent::ServiceResolved(svc) => {
                        let Some(id) = svc.get_property_val_str("id").map(str::to_string) else {
                            continue;
                        };
                        if id == shared.id {
                            continue; // c'est nous
                        }
                        let Some(ip) = svc.get_addresses_v4().into_iter().min() else {
                            continue;
                        };
                        let device = Device {
                            name: svc
                                .get_property_val_str("name")
                                .unwrap_or("Ordinateur")
                                .to_string(),
                            id: id.clone(),
                            ip: ip.to_string(),
                            port: svc.port,
                        };
                        names.insert(svc.fullname.clone(), id.clone());
                        let changed = shared.devices.lock().unwrap().insert(id, device.clone())
                            != Some(device.clone());
                        if changed {
                            shared.emit(Event::DeviceFound { device });
                        }
                    }
                    ServiceEvent::ServiceRemoved(_, fullname) => {
                        if let Some(id) = names.remove(&fullname) {
                            shared.devices.lock().unwrap().remove(&id);
                            shared.emit(Event::DeviceLost { id });
                        }
                    }
                    _ => {}
                }
            }
        });

        Ok(Self { daemon, fullname })
    }
}

impl Drop for Discovery {
    fn drop(&mut self) {
        // Prévient les autres PC qu'on s'en va.
        let _ = self.daemon.unregister(&self.fullname);
        let _ = self.daemon.shutdown();
    }
}
