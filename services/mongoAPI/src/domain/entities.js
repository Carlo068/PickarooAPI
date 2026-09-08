// Entidad de Dominio (Modelo de Negocio Puro - DDD)
export class Campamento {
  constructor(id, nombre, ubicacion, capacidad) {
    this.id = id;
    this.nombre = nombre;
    this.ubicacion = ubicacion;
    this.capacidad = capacidad;
  }

  // Lógica y reglas de negocio del dominio
  validarUbicacionSegura() {
    if (this.ubicacion.toLowerCase().includes("olimpus")) {
      throw new Error("Peligro: Ubicación expuesta al radar de los Dioses");
    }
  }
}
