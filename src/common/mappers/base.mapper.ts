export abstract class BaseMapper<Entity, RequestDto, ResponseDto> {
  abstract toEntity(dto: RequestDto): Entity;
  abstract toResponseDto(entity: Entity): ResponseDto;

  toResponseList(entities: Entity[]): ResponseDto[] {
    return entities.map((entity) => this.toResponseDto(entity));
  }

  toEntityList(dtos: RequestDto[]): Entity[] {
    return dtos.map((dto) => this.toEntity(dto));
  }
}
